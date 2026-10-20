// Accounting settings and tax rates: the company profile, document numbering, payment terms, the
// reminder ladder, tax registration and the organization's tax rates. Read with acct.view; changed by
// the finance controller (acct.control). Document numbers are allocated here, inside the transaction
// that creates the document, so two documents never share a number.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { ensureBooks, requireAcct, round2 } from '../ledger/ledger.service.js';
import { STARTER_ORG_PROFILE, STARTER_PAYMENT_TERMS, STARTER_REMINDER_RULES, STARTER_SEQUENCES, STARTER_TAX_RATES, STARTER_TAX_REGISTRATION } from '../accounting.seed.js';

const org = (context) => ({ organizationId: context.organizationId });

export async function ensureSettings(tx, context) {
  await ensureBooks(tx, context);
  const row = await tx.acctSettings.findUnique({ where: { organizationId: context.organizationId } });
  if (row) return row;
  await tx.acctTaxRate.createMany({ data: STARTER_TAX_RATES.map((r) => ({ ...org(context), id: r.id, name: r.name, kind: r.kind, rate: r.rate, description: r.description ?? null, accountNumber: r.accountNumber, isCompound: r.isCompound, isActive: r.isActive })), skipDuplicates: true });
  return tx.acctSettings.create({
    data: { ...org(context), orgProfile: STARTER_ORG_PROFILE, sequences: STARTER_SEQUENCES, paymentTerms: STARTER_PAYMENT_TERMS, reminderRules: STARTER_REMINDER_RULES, taxRegistration: STARTER_TAX_REGISTRATION },
  });
}

/** The next number for a document kind ("invoice" → INV-2026-000001), allocated under a row lock. */
export async function nextDocNumber(tx, context, key) {
  await ensureSettings(tx, context);
  const [row] = await tx.$queryRaw`SELECT "sequences" FROM "acct_settings" WHERE "organization_id" = ${context.organizationId} FOR UPDATE`;
  const sequences = row.sequences;
  const s = sequences.find((x) => x.key === key);
  if (!s) throw new EmrError('INVALID_STATE', { message: `No numbering is set up for ${key}.` });
  const number = `${s.prefix}${new Date().getUTCFullYear()}-${String(s.next).padStart(s.padding, '0')}`;
  await tx.acctSettings.updateMany({ where: org(context), data: { sequences: sequences.map((x) => (x.key === key ? { ...x, next: x.next + 1 } : x)) } });
  return number;
}

/** Due date for a document dated `date` under a payment term (end-of-month terms land on the month end). */
export function dueDateFor(settings, date, termId, fallbackDays = 30) {
  const term = settings.paymentTerms.find((t) => t.id === termId);
  const d = new Date(new Date(date).getTime() + (term ? term.netDays : fallbackDays) * 86_400_000);
  return term?.eom ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12)) : d;
}

// ---- taxes ------------------------------------------------------------------------------------------
export async function taxRates(tx, context) {
  await ensureSettings(tx, context);
  return new Map((await tx.acctTaxRate.findMany({ where: org(context) })).map((r) => [r.id, { ...r, rate: Number(r.rate) }]));
}
export const taxIdsOf = (line) => (line.taxRateIds?.length ? line.taxRateIds : line.taxRateId ? [line.taxRateId] : []);
/** Taxes stacked on a net amount, grouped by the liability account they post to. */
export function taxBreakdown(rates, net, ids) {
  const groups = new Map();
  for (const id of ids) {
    const r = rates.get(id);
    if (!r) throw new EmrError('VALIDATION_FAILED', { message: `Unknown tax rate ${id}.` });
    if (r.rate <= 0) continue;
    const amt = round2((net * r.rate) / 100);
    const cur = groups.get(r.accountNumber) ?? { amount: 0, label: r.name };
    groups.set(r.accountNumber, { amount: round2(cur.amount + amt), label: cur.label === r.name ? r.name : `${cur.label} + ${r.name}` });
  }
  return [...groups.entries()].map(([accountNumber, v]) => ({ accountNumber, amount: v.amount, label: v.label }));
}
export const lineAmount = (l) => round2(l.qty * l.unitPrice);
export const docSubtotal = (lines) => round2(lines.reduce((n, l) => n + lineAmount(l), 0));
export function docTaxBreakdown(rates, lines) {
  const groups = new Map();
  for (const l of lines) for (const b of taxBreakdown(rates, lineAmount(l), taxIdsOf(l))) {
    const cur = groups.get(b.accountNumber) ?? { amount: 0, label: b.label };
    groups.set(b.accountNumber, { amount: round2(cur.amount + b.amount), label: b.label });
  }
  return [...groups.entries()].map(([accountNumber, v]) => ({ accountNumber, amount: v.amount, label: v.label }));
}
export const docTax = (rates, lines) => round2(docTaxBreakdown(rates, lines).reduce((n, b) => n + b.amount, 0));
export const docTotal = (rates, lines) => round2(docSubtotal(lines) + docTax(rates, lines));

// ---- reading and changing ---------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    const s = await ensureSettings(tx, context);
    const rates = await tx.acctTaxRate.findMany({ where: org(context), orderBy: { name: 'asc' } });
    return {
      org: s.orgProfile, sequences: s.sequences, paymentTerms: s.paymentTerms, reminderRules: s.reminderRules, taxRegistration: s.taxRegistration, setup: { steps: s.setupSteps }, version: s.version,
      taxRates: rates.map((r) => ({ id: r.id, name: r.name, kind: r.kind, rate: Number(r.rate), description: r.description ?? undefined, accountNumber: r.accountNumber, isCompound: r.isCompound, isActive: r.isActive, version: r.version })),
    };
  });
}
export async function saveSettings(context, expectedVersion, patch) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    if (patch.sequences) {
      const current = (await tx.acctSettings.findUnique({ where: { organizationId: context.organizationId } })).sequences;
      for (const s of patch.sequences) {
        const was = current.find((x) => x.key === s.key);
        if (!was) throw new EmrError('VALIDATION_FAILED', { message: `Unknown numbering ${s.key}.` });
        if (s.next < was.next) throw new EmrError('VALIDATION_FAILED', { message: `${was.label} numbering cannot go back below ${was.next} (numbers already issued).` });
      }
    }
    const data = Object.fromEntries(Object.entries({ orgProfile: patch.org, sequences: patch.sequences, paymentTerms: patch.paymentTerms, reminderRules: patch.reminderRules, taxRegistration: patch.taxRegistration, setupSteps: patch.setupSteps }).filter(([, v]) => v !== undefined));
    const { count } = await tx.acctSettings.updateMany({ where: { ...org(context), version: expectedVersion }, data: { ...data, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
    if (!count) throw new EmrError('VERSION_CONFLICT');
    await recordAudit(tx, context, { action: 'accounting.settings_saved', resourceType: 'accounting_settings', changedFields: Object.keys(data) });
    return { saved: true };
  });
}
export async function addTaxRate(context, input) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    if (!(await tx.acctAccount.findFirst({ where: { ...org(context), number: input.accountNumber } }))) throw new EmrError('ACCOUNT_NOT_FOUND');
    const id = input.id ?? `tax-${Math.random().toString(36).slice(2, 9)}`;
    await tx.acctTaxRate.create({ data: { ...org(context), id, name: input.name, kind: input.kind, rate: input.rate, description: input.description ?? null, accountNumber: input.accountNumber, isCompound: input.isCompound ?? false } });
    await recordAudit(tx, context, { action: 'tax_rate.created', resourceType: 'tax_rate', resourceId: id });
    return { id };
  });
}
export async function updateTaxRate(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { count } = await tx.acctTaxRate.updateMany({ where: { ...org(context), id, version: expectedVersion }, data: { ...data, version: { increment: 1 } } });
    if (!count) throw (await tx.acctTaxRate.findFirst({ where: { ...org(context), id } })) ? new EmrError('VERSION_CONFLICT') : new EmrError('HR_RECORD_NOT_FOUND');
    await recordAudit(tx, context, { action: 'tax_rate.updated', resourceType: 'tax_rate', resourceId: id, changedFields: Object.keys(data) });
    return { id };
  });
}
