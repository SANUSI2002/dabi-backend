// The self-service portal: a customer (or supplier) opens their account with the hospital from a link —
// their statement, their invoices as PDF and how to pay (or, for a supplier, their bills and remittance
// advice). There is no online payment: the portal shows the hospital's payment instructions.
//
// Staff with acct.post create a link for a customer or vendor (valid 1–180 days), and can email it to a
// customer; acct.view lists a party's links; acct.post revokes one. The link's token is shown once and
// only its SHA-256 is stored. A link works while it is unexpired and unrevoked, and only while the
// hospital is still entitled to Accounting; each use is counted. The portal reads only the one party's
// own records, as the hospital (RLS), and never anything about other customers or suppliers.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import prisma from '../../../config/db.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { approvedProductFor, accountingApiEnabled } from '../../emr/emr.entitlement.js';
import { requireAcct, round2 } from '../ledger/ledger.service.js';
import { docTotal, ensureSettings, taxRates } from '../settings/settings.service.js';
import { queueCustomerEmail, senderFor } from '../email/customerEmail.js';
import { customerStatementInTx, invoicePdfInTx, issuerOf, statementPdf, vendorStatementInTx } from '../documents/documents.service.js';
import { renderRemittancePdf } from '../documents/financePdf.js';

const PORTAL = 'finance-portal';
const DAY = 86_400_000;
const hash = (token) => createHash('sha256').update(token).digest('hex');
const linkGone = () => new EmrError('HR_RECORD_NOT_FOUND', { message: 'This link has expired or is no longer valid. Ask the hospital for a new one.' });
const portalUrl = (token) => `${(process.env.APP_PUBLIC_URL ?? '').replace(/\/$/, '')}/portal/${token}`;
const iso = (d) => (d ? d.toISOString() : undefined);
const fileSafe = (s) => String(s).replace(/[^\w.-]+/g, '-').slice(0, 80);

async function partyOf(tx, context, partyKind, partyId) {
  const where = { organizationId: context.organizationId, id: partyId };
  const party = partyKind === 'vendor' ? await tx.acctVendor.findFirst({ where }) : await tx.acctCustomer.findFirst({ where });
  if (!party) throw new EmrError('HR_RECORD_NOT_FOUND', { message: `${partyKind === 'vendor' ? 'Vendor' : 'Customer'} not found.` });
  return party;
}

// ---- staff: links -----------------------------------------------------------------------------------
/** Creates a link; the token is in the reply only this once. With `email`, it is emailed to the customer. */
export async function createLink(context, { partyKind, partyId, days = 30, email = false }) {
  requireAcct(context, 'acct.post');
  if (email && partyKind !== 'customer') throw new EmrError('VALIDATION_FAILED', { message: 'Portal links are emailed to customers; copy the link for a supplier.' });
  const sender = email ? await senderFor(context) : null;
  return withTenant(context, async (tx) => {
    const party = await partyOf(tx, context, partyKind, partyId);
    if (email && !party.email) throw new EmrError('VALIDATION_FAILED', { message: `${party.name} has no email address on file.` });
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const link = await tx.acctPortalLink.create({
      data: { id: randomUUID(), organizationId: context.organizationId, partyKind, partyId, tokenHash: hash(token), createdByUserId: context.userId, createdAt: now, expiresAt: new Date(now.getTime() + days * DAY) },
    });
    await recordAudit(tx, context, { action: 'portal_link.created', resourceType: `${partyKind}_portal_link`, resourceId: link.id, changedFields: [String(days)] });
    let delivery;
    if (email) {
      const settings = await ensureSettings(tx, context);
      const hospital = issuerOf(settings, sender).name;
      const notice = await tx.acctCustomerNotice.create({ data: { organizationId: context.organizationId, kind: 'portal', customerId: party.id, sentTo: party.email, sentByUserId: context.userId } });
      delivery = await queueCustomerEmail(tx, context, {
        noticeId: notice.id, recipient: party.email, sender, hospitalName: hospital,
        subject: `Your account with ${hospital}`,
        body: [
          `Dear ${party.name},`, '',
          `You can see your statement, download your invoices and find how to pay ${hospital} here:`, '', portalUrl(token), '',
          `The link works until ${link.expiresAt.toISOString().slice(0, 10)}. Keep it private: anyone with it can see your account with us.`,
        ].join('\n'),
      });
    }
    return { id: link.id, url: portalUrl(token), token, expiresAt: iso(link.expiresAt), ...(delivery ? { delivery } : {}) };
  });
}
/** A party's links, newest first (never their tokens). */
export async function listLinks(context, { partyKind, partyId }) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const links = await tx.acctPortalLink.findMany({ where: { organizationId: context.organizationId, partyKind, partyId }, orderBy: { createdAt: 'desc' }, take: 50 });
    const names = await userNameMap(tx, links.flatMap((l) => [l.createdByUserId, l.revokedByUserId].filter(Boolean)));
    const now = Date.now();
    return {
      items: links.map((l) => ({
        id: l.id, createdAt: iso(l.createdAt), createdBy: names.get(l.createdByUserId) ?? 'Former member', expiresAt: iso(l.expiresAt), lastUsedAt: iso(l.lastUsedAt), useCount: l.useCount,
        status: l.revokedAt ? 'Revoked' : l.expiresAt.getTime() <= now ? 'Expired' : 'Active', ...(l.revokedAt ? { revokedAt: iso(l.revokedAt), revokedBy: names.get(l.revokedByUserId) ?? 'Former member' } : {}),
      })),
    };
  });
}
export async function revokeLink(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const { count } = await tx.acctPortalLink.updateMany({ where: { organizationId: context.organizationId, id, revokedAt: null }, data: { revokedAt: new Date(), revokedByUserId: context.userId } });
    if (!count) throw new EmrError('INVALID_STATE', { message: 'This link is already revoked, or was not found.' });
    await recordAudit(tx, context, { action: 'portal_link.revoked', resourceType: 'portal_link', resourceId: id });
    return { id, status: 'Revoked' };
  });
}

// ---- the portal -------------------------------------------------------------------------------------
/** The link behind a token, if it still works: its organization, party and a read-only context. */
async function open(token, db = prisma) {
  if (typeof token !== 'string' || !/^[\w-]{40,60}$/.test(token) || !accountingApiEnabled()) throw linkGone();
  const link = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE sabi_emr_app');
    await tx.$executeRaw`SELECT set_config('app.system_context', ${PORTAL}, true)`;
    return tx.acctPortalLink.findUnique({ where: { tokenHash: hash(token) } });
  }, { maxWait: 5000, timeout: 15000 });
  if (!link || link.revokedAt || link.expiresAt.getTime() <= Date.now()) throw linkGone();
  const org = await db.identityOrganization.findUnique({ where: { id: link.organizationId }, select: { type: true, organisationId: true, organisation: { select: { name: true } } } });
  if (!org || !(await approvedProductFor({ organization: { type: org.type, facilityId: org.organisationId } }, 'accounting', db))) throw linkGone();
  // the portal reads as the hospital, with read-only finance access, on behalf of the staff member who made the link
  const context = { organizationId: link.organizationId, facilityId: org.organisationId, userId: link.createdByUserId, permissions: ['acct.view'], roles: [] };
  return { link, context, sender: { hospitalName: org.organisation?.name ?? 'Your hospital', replyTo: null, staffName: null } };
}
const touch = (tx, link) => tx.acctPortalLink.updateMany({ where: { organizationId: link.organizationId, id: link.id }, data: { lastUsedAt: new Date(), useCount: { increment: 1 } } });

/** Everything the portal page shows. */
export async function portalView(token, { from, to } = {}) {
  const { link, context, sender } = await open(token);
  return withTenant(context, async (tx) => {
    await touch(tx, link);
    const settings = await ensureSettings(tx, context);
    const issuer = issuerOf(settings, sender);
    const rates = await taxRates(tx, context);
    const since = new Date(Date.now() - 2 * 366 * DAY);
    const period = { from: from ?? new Date(Date.now() - 365 * DAY).toISOString(), to };
    const hospital = { name: issuer.name, address: issuer.address, phone: issuer.phone, email: issuer.email, paymentInstructions: issuer.paymentInstructions };
    const money = (d) => { const t = docTotal(rates, d.lines); return { total: t, balance: round2(t - Number(d.amountPaid)) }; };
    if (link.partyKind === 'customer') {
      const built = await customerStatementInTx(tx, context, link.partyId, period);
      const invoices = await tx.acctSalesDoc.findMany({ where: { organizationId: context.organizationId, kind: 'invoice', customerId: link.partyId, status: { notIn: ['Draft'] }, docDate: { gte: since } }, orderBy: { docDate: 'desc' }, take: 200 });
      return {
        kind: 'customer', hospital, party: { name: built.party.name }, expiresAt: iso(link.expiresAt), statement: presentStatement(built.statement),
        invoices: invoices.map((i) => ({ id: i.id, number: i.number, date: iso(i.docDate), dueDate: iso(i.dueDate), currency: i.currency, status: ['Open', 'Partially Paid'].includes(i.status) && i.dueDate && i.dueDate < new Date() ? 'Overdue' : i.status, ...money(i) })),
      };
    }
    const built = await vendorStatementInTx(tx, context, link.partyId, period);
    const [bills, payments] = await Promise.all([
      tx.acctPurchaseDoc.findMany({ where: { organizationId: context.organizationId, kind: 'bill', vendorId: link.partyId, status: { in: ['Awaiting Payment', 'Partially Paid', 'Paid'] }, docDate: { gte: since } }, orderBy: { docDate: 'desc' }, take: 200 }),
      tx.acctVendorPayment.findMany({ where: { organizationId: context.organizationId, vendorId: link.partyId, status: 'Posted', paymentDate: { gte: since } }, orderBy: { paymentDate: 'desc' }, take: 200 }),
    ]);
    return {
      kind: 'vendor', hospital: { ...hospital, paymentInstructions: '' }, party: { name: built.party.name }, expiresAt: iso(link.expiresAt), statement: presentStatement(built.statement),
      bills: bills.map((b) => ({ id: b.id, number: b.number, yourReference: b.vendorInvoiceNumber ?? undefined, date: iso(b.docDate), dueDate: iso(b.dueDate), currency: b.currency, status: b.status, ...money(b) })),
      payments: payments.map((p) => ({ id: p.id, number: p.number, date: iso(p.paymentDate), method: p.method, amount: Number(p.amount), withheldTax: Number(p.withheldTax), reference: p.reference ?? undefined })),
    };
  });
}
const presentStatement = (s) => ({
  from: iso(s.from), to: iso(s.to), currency: s.currency, openingBalance: s.openingBalance, closingBalance: s.closingBalance,
  lines: s.lines.map((l) => ({ ...l, date: iso(l.date) })), aging: s.aging,
  open: s.open.map((o) => ({ number: o.number, date: iso(o.date), dueDate: iso(o.dueDate), currency: o.currency, total: o.total, balance: o.balance, overdue: o.overdue })),
});

/** A customer's own invoice as PDF (never a draft, never another customer's). */
export async function portalInvoicePdf(token, invoiceId) {
  const { link, context, sender } = await open(token);
  if (link.partyKind !== 'customer') throw linkGone();
  return withTenant(context, async (tx) => {
    const inv = await tx.acctSalesDoc.findFirst({ where: { organizationId: context.organizationId, id: invoiceId, kind: 'invoice', customerId: link.partyId, status: { not: 'Draft' } } });
    if (!inv) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Invoice not found.' });
    await touch(tx, link);
    return invoicePdfInTx(tx, context, inv, sender);
  });
}
/** The party's statement as PDF. */
export async function portalStatementPdf(token, { from, to } = {}) {
  const { link, context, sender } = await open(token);
  return withTenant(context, async (tx) => {
    const built = link.partyKind === 'vendor' ? await vendorStatementInTx(tx, context, link.partyId, { from, to }) : await customerStatementInTx(tx, context, link.partyId, { from, to });
    await touch(tx, link);
    return statementPdf(await ensureSettings(tx, context), sender, built);
  });
}
/** Remittance advice for one of the supplier's own posted payments. */
export async function portalRemittancePdf(token, paymentId) {
  const { link, context, sender } = await open(token);
  if (link.partyKind !== 'vendor') throw linkGone();
  return withTenant(context, async (tx) => {
    const p = await tx.acctVendorPayment.findFirst({ where: { organizationId: context.organizationId, id: paymentId, vendorId: link.partyId, status: 'Posted' } });
    if (!p) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Payment not found.' });
    const [vendor, bills, settings] = await Promise.all([
      tx.acctVendor.findFirst({ where: { organizationId: context.organizationId, id: p.vendorId } }),
      tx.acctPurchaseDoc.findMany({ where: { organizationId: context.organizationId, kind: 'bill', id: { in: p.allocations.map((a) => a.billId) } } }),
      ensureSettings(tx, context),
    ]);
    await touch(tx, link);
    const byId = new Map(bills.map((b) => [b.id, b]));
    const bytes = await renderRemittancePdf({
      issuer: issuerOf(settings, sender), vendor: { name: vendor.name, address: vendor.address ?? '', email: vendor.email ?? '', phone: vendor.phone ?? '' },
      payment: {
        number: p.number, date: p.paymentDate, method: p.method, reference: p.reference ?? '', amount: Number(p.amount), withheldTax: Number(p.withheldTax), currency: 'NGN',
        allocations: p.allocations.map((a) => { const b = byId.get(a.billId); return { number: b?.number ?? '', vendorInvoiceNumber: b?.vendorInvoiceNumber ?? '', date: b?.docDate, amount: a.amount }; }),
      },
    });
    return { filename: `Remittance-${fileSafe(p.number)}.pdf`, bytes };
  });
}
