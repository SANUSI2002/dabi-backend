// Accounting alerts by email: a digest, to each staff member who turned on "emailDigest" in their
// notification preferences, of the same alerts the Accounting screens show them — documents waiting for
// their approval, overdue invoices, bills due within a week, stock at its reorder level, budget lines
// over budget and large journal entries — each only if that alert is on for them.
//
// Every alert sent to a person is remembered: a digest holds only alerts that are new to them (or still
// outstanding a week after they were last told). A person gets at most one digest every six hours; their
// "~digest" row is claimed before sending so two API instances never both send it. Approvals are only the
// ones that person may decide today (their current roles), never their own submissions. Someone who has
// left the organization, lost finance access or has no email address gets nothing.
import { setInterval, clearInterval } from 'node:timers';
import prisma from '../../../config/db.js';
import { withTenant } from '../../emr/core/db.js';
import { round2, totalsByAccount } from '../ledger/ledger.service.js';
import { docTotal, ensureSettings, taxRates } from '../settings/settings.service.js';
import { mayDecide } from '../control/approvals.service.js';
import { emailConfigured, sendCustomerEmail } from './customerEmail.js';
import { passwordResetEmailAllowedFor } from '../../auth/auth.email.js';

const WORKER = 'finance-alert-worker';
const HOUR = 3_600_000;
const DIGEST_EVERY = 6 * HOUR;
const REMIND_AFTER = 7 * 24 * HOUR;
const LARGE_JOURNAL = 5_000_000;
const DIGEST = '~digest';
const DEFAULTS = { approvalPending: true, invoiceOverdue: true, billDueSoon: true, lowStock: true, budgetExceeded: true, largeJournal: false };
const naira = (n) => `NGN ${Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');

/** Who opted in, across organizations (the worker's one cross-tenant read). */
async function optedIn(db = prisma) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL ROLE sabi_emr_app');
    await tx.$executeRaw`SELECT set_config('app.system_context', ${WORKER}, true)`;
    return tx.$queryRaw`SELECT "organization_id" AS "organizationId", "user_id" AS "userId", "prefs" FROM "acct_notification_prefs" WHERE ("prefs"->>'emailDigest')::boolean IS TRUE`;
  }, { maxWait: 5000, timeout: 15000 });
}

/** The person as finance staff of the organization today: their email, name and finance permissions. */
async function staffMember(organizationId, userId, db = prisma) {
  const m = await db.organizationMembership.findFirst({
    where: { organizationId, userId, status: 'ACTIVE', user: { accountStatus: 'ACTIVE' } },
    select: { user: { select: { email: true, full_name: true } }, organization: { select: { organisation: { select: { name: true } }, pharmacy: { select: { name: true } } } }, roles: { select: { role: { select: { permissions: { select: { permissionCode: true } } } } } } },
  });
  if (!m) return null;
  const permissions = [...new Set(m.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionCode)))];
  if (!permissions.includes('acct.view') || !m.user.email) return null;
  return { email: m.user.email, name: m.user.full_name ?? '', hospital: m.organization?.organisation?.name ?? m.organization?.pharmacy?.name ?? 'Your hospital', permissions };
}

/** The alerts for one person, as the screens would show them, computed from the organization's books. */
export async function alertsFor(tx, context, prefs, now = new Date()) {
  const on = { ...DEFAULTS, ...prefs };
  const org = { organizationId: context.organizationId };
  const out = [];
  const rates = await taxRates(tx, context);

  if (on.approvalPending) {
    const [docs, payments, journals, claims] = await Promise.all([
      tx.acctPurchaseDoc.findMany({ where: { ...org, status: 'Pending Approval' }, select: { id: true, kind: true, number: true, approval: true, lines: true } }),
      tx.acctVendorPayment.findMany({ where: { ...org, status: 'Pending Approval' }, select: { id: true, number: true, approval: true, amount: true } }),
      tx.acctJournalEntry.findMany({ where: { ...org, status: 'Pending Approval' }, select: { id: true, number: true, approval: true, memo: true } }),
      tx.acctExpenseClaim.findMany({ where: { ...org, status: 'Pending Approval' }, select: { id: true, number: true, approval: true, title: true } }),
    ]);
    const label = { bill: 'Bill', requisition: 'Purchase requisition' };
    for (const d of docs) if (mayDecide(context, d.approval)) out.push({ id: `appr-${d.id}`, group: 'Waiting for your approval', text: `${label[d.kind] ?? 'Document'} ${d.number} — ${naira(docTotal(rates, d.lines))}`, path: d.kind === 'bill' ? '/accounting/bills' : '/accounting/requisitions' });
    for (const p of payments) if (mayDecide(context, p.approval)) out.push({ id: `appr-${p.id}`, group: 'Waiting for your approval', text: `Vendor payment ${p.number} — ${naira(p.amount)}`, path: '/accounting/vendor-payments' });
    for (const j of journals) if (mayDecide(context, j.approval)) out.push({ id: `appr-${j.id}`, group: 'Waiting for your approval', text: `Journal ${j.number} — ${j.memo}`, path: '/accounting/journals' });
    for (const c of claims) if (mayDecide(context, c.approval)) out.push({ id: `appr-${c.id}`, group: 'Waiting for your approval', text: `Expense claim ${c.number} — ${c.title}`, path: '/accounting/expenses' });
  }
  if (on.invoiceOverdue) {
    const overdue = await tx.acctSalesDoc.findMany({ where: { ...org, kind: 'invoice', status: { in: ['Open', 'Partially Paid'] }, dueDate: { lt: now } }, orderBy: { dueDate: 'asc' }, take: 200 });
    const names = new Map((await tx.acctCustomer.findMany({ where: { ...org, id: { in: [...new Set(overdue.map((i) => i.customerId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
    for (const i of overdue) out.push({ id: `inv-${i.id}`, group: 'Overdue invoices', text: `${i.number} — ${names.get(i.customerId) ?? 'Customer'}, ${naira(round2(docTotal(rates, i.lines) - Number(i.amountPaid)) * Number(i.exchangeRate))} due ${day(i.dueDate)}`, path: '/accounting/invoices' });
  }
  if (on.billDueSoon) {
    const soon = await tx.acctPurchaseDoc.findMany({ where: { ...org, kind: 'bill', status: { in: ['Awaiting Payment', 'Partially Paid'] }, dueDate: { gte: now, lte: new Date(now.getTime() + 7 * 24 * HOUR) } }, orderBy: { dueDate: 'asc' }, take: 200 });
    const names = new Map((await tx.acctVendor.findMany({ where: { ...org, id: { in: [...new Set(soon.map((b) => b.vendorId))] } }, select: { id: true, name: true } })).map((v) => [v.id, v.name]));
    for (const b of soon) out.push({ id: `bill-${b.id}`, group: 'Bills due within 7 days', text: `${b.number} — ${names.get(b.vendorId) ?? 'Vendor'}, ${naira(round2(docTotal(rates, b.lines) - Number(b.amountPaid)) * Number(b.exchangeRate))} due ${day(b.dueDate)}`, path: '/accounting/bills' });
  }
  if (on.lowStock) {
    const [items, onHand] = await Promise.all([
      tx.emrStoreItem.findMany({ where: { ...org, active: true, reorderLevel: { gt: 0 } }, select: { id: true, name: true, reorderLevel: true } }),
      tx.emrStoreBatch.groupBy({ by: ['itemId'], where: { ...org, qtyRemaining: { gt: 0 } }, _sum: { qtyRemaining: true } }),
    ]);
    const qty = new Map(onHand.map((r) => [r.itemId, Number(r._sum.qtyRemaining ?? 0)]));
    for (const it of items) { const q = qty.get(it.id) ?? 0; if (q <= it.reorderLevel) out.push({ id: `stk-${it.id}`, group: 'Stock at its reorder level', text: `${it.name} — ${q} on hand, reorder at ${it.reorderLevel}`, path: '/accounting/inventory' }); }
  }
  if (on.budgetExceeded) {
    const year = now.getUTCFullYear();
    const budget = await tx.acctBudget.findFirst({ where: { ...org, fiscalYear: year, status: 'Active' } });
    if (budget?.lines?.length) {
      const month = now.getUTCMonth();
      const actual = await totalsByAccount(tx, context, { from: new Date(Date.UTC(year, 0, 1)), asOf: now });
      const accounts = new Map((await tx.acctAccount.findMany({ where: org, select: { number: true, name: true, type: true } })).map((a) => [a.number, a]));
      const byAccount = new Map();
      for (const l of budget.lines) byAccount.set(l.accountNumber, round2((byAccount.get(l.accountNumber) ?? 0) + l.monthly.slice(0, month + 1).reduce((n, v) => n + v, 0)));
      for (const [number, planned] of byAccount) {
        const a = accounts.get(number);
        if (!a || a.type === 'revenue' || planned <= 0) continue;
        const t = actual.get(number); const spent = t ? round2(t.debit - t.credit) : 0;
        if (spent > planned) out.push({ id: `bud-${year}-${number}`, group: 'Over budget (year to date)', text: `${number} ${a.name} — ${naira(spent)} spent of ${naira(planned)} (${Math.round((spent / planned) * 100)}%)`, path: '/accounting/budgets' });
      }
    }
  }
  if (on.largeJournal) {
    const rows = await tx.$queryRaw`
      SELECT e."id", e."number", e."memo", SUM(l."debit") AS "debits" FROM "acct_journal_entries" e JOIN "acct_journal_lines" l ON l."organization_id" = e."organization_id" AND l."entry_id" = e."id"
      WHERE e."organization_id" = ${context.organizationId} AND e."status" = 'Posted' AND e."posted_at" >= ${new Date(now.getTime() - 7 * 24 * HOUR)}
      GROUP BY e."id", e."number", e."memo" HAVING SUM(l."debit") >= ${LARGE_JOURNAL}`;
    for (const r of rows) out.push({ id: `je-${r.id}`, group: 'Large journal entries (past week)', text: `${r.number} — ${r.memo}, ${naira(r.debits)}`, path: '/accounting/journals' });
  }
  return out;
}

/** The digest's text: alerts grouped under headings, each with where to look in Sabi. */
export function digestText({ name, hospital, alerts, appUrl }) {
  const groups = new Map();
  for (const a of alerts) groups.set(a.group, [...(groups.get(a.group) ?? []), a]);
  const lines = [`Hello${name ? ` ${name}` : ''},`, '', `${alerts.length} accounting alert${alerts.length === 1 ? '' : 's'} at ${hospital}:`];
  for (const [group, list] of groups) {
    lines.push('', `${group} (${list.length})`);
    for (const a of list.slice(0, 25)) lines.push(`  • ${a.text}`);
    if (list.length > 25) lines.push(`  …and ${list.length - 25} more`);
    if (appUrl) lines.push(`  Open: ${appUrl}${list[0].path}`);
  }
  lines.push('', 'You get this because email alerts are on in your Accounting notification settings. Turn them off there at any time.');
  return lines.join('\n');
}

/** Sends due digests, a person at a time; returns how many were sent. */
export async function sendAlertDigests({ now = new Date(), send = sendCustomerEmail, configured = emailConfigured, db = prisma } = {}) {
  if (!configured()) return 0;
  let sent = 0;
  for (const { organizationId, userId, prefs } of await optedIn(db)) {
    const person = await staffMember(organizationId, userId, db);
    if (!person || !passwordResetEmailAllowedFor(person.email)) continue;
    const context = { organizationId, userId, permissions: person.permissions };
    // claim this person's digest slot, then work out what is new to them
    const plan = await withTenant(context, async (tx) => {
      await tx.acctAlertDelivery.createMany({ data: [{ organizationId, userId, alertId: DIGEST, sentAt: new Date(0) }], skipDuplicates: true });
      const claimed = await tx.acctAlertDelivery.updateMany({ where: { organizationId, userId, alertId: DIGEST, sentAt: { lt: new Date(now.getTime() - DIGEST_EVERY) } }, data: { sentAt: now } });
      if (!claimed.count) return null;
      const settings = await ensureSettings(tx, context);
      const hospital = settings.orgProfile?.tradingName || settings.orgProfile?.legalName || person.hospital;
      const alerts = await alertsFor(tx, context, prefs, now);
      const told = new Map((await tx.acctAlertDelivery.findMany({ where: { organizationId, userId, alertId: { in: alerts.map((a) => a.id) } } })).map((d) => [d.alertId, d.sentAt]));
      const fresh = alerts.filter((a) => !told.has(a.id) || told.get(a.id).getTime() < now.getTime() - REMIND_AFTER);
      return { fresh, hospital };
    }, { db });
    if (!plan) continue;
    if (!plan.fresh.length) {
      // nothing new: free the slot so a new alert is emailed without waiting six hours
      await withTenant(context, (tx) => tx.acctAlertDelivery.updateMany({ where: { organizationId, userId, alertId: DIGEST, sentAt: now }, data: { sentAt: new Date(0) } }), { db });
      continue;
    }
    const job = {
      id: `alerts-${organizationId}-${userId}-${Math.floor(now.getTime() / DIGEST_EVERY)}`, recipient: person.email, replyTo: null, fromName: `${plan.hospital} — Sabi accounting`.slice(0, 120),
      subject: `${plan.fresh.length} accounting alert${plan.fresh.length === 1 ? '' : 's'} — ${plan.hospital}`.slice(0, 300),
      body: digestText({ name: person.name, hospital: plan.hospital, alerts: plan.fresh, appUrl: (process.env.APP_PUBLIC_URL ?? '').replace(/\/$/, '') }).slice(0, 20000),
    };
    let result;
    try { result = await send(job); } catch { result = { ok: false }; }
    await withTenant(context, async (tx) => {
      if (!result.ok) {
        // not sent: give the slot back so the next run tries again
        await tx.acctAlertDelivery.updateMany({ where: { organizationId, userId, alertId: DIGEST, sentAt: now }, data: { sentAt: new Date(0) } });
        return;
      }
      for (const a of plan.fresh) await tx.acctAlertDelivery.upsert({ where: { organizationId_userId_alertId: { organizationId, userId, alertId: a.id } }, create: { organizationId, userId, alertId: a.id, sentAt: now }, update: { sentAt: now } });
    }, { db });
    if (result.ok) sent += 1;
  }
  return sent;
}

export function startStaffAlertWorker() {
  if (process.env.FINANCE_ALERT_WORKER_ENABLED === 'false') return () => {};
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || !emailConfigured()) return;
    busy = true;
    try { await sendAlertDigests(); } catch { console.error('[finance-alerts] Alert digests unavailable; they will be retried.'); } finally { busy = false; }
  }, 15 * 60_000);
  timer.unref?.();
  return () => clearInterval(timer);
}
