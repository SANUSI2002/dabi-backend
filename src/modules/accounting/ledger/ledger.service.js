// The general ledger: chart of accounts, branches, fiscal calendar and locks, journal entries.
//
// Rules enforced here (and, for balance and immutability, again by the database):
//   - every posted entry balances, has at least two lines and is not for zero; lines are debit or credit;
//   - nothing posts to a locked period or before the books-locked-before date;
//   - a manual entry cannot touch control accounts (receivables, payables, inventory, accumulated
//     depreciation) — those are posted only by their subledger;
//   - a posted entry is never edited: it is corrected by a reversing entry, and an entry is reversed once;
//   - balances are not stored: they are the sum of posted lines (an entry that has been reversed still
//     counts — its reversal offsets it);
//   - acct.view reads; acct.post prepares and posts; acct.control (finance controller) reverses, sets up
//     the chart, branches and locks, and closes the year.
// Subledgers (receivables, payables, banking…) post through postEntry() inside their own transaction.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { nextSequence } from '../../emr/core/sequence.js';
import { userNameMap } from '../../emr/core/people.js';
import { COA_TEMPLATES, CONTROL_SUBTYPES, STARTER_APPROVAL_RULES, STARTER_CHART, STARTER_FX_RATES } from '../accounting.seed.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, permission) => context.permissions.includes(permission);
export const requireAcct = (context, permission) => { if (!can(context, permission) && !can(context, 'acct.control')) throw new EmrError('PERMISSION_DENIED'); };
export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
export const isDebitNormal = (a) => (a.subtype === 'contra_asset' ? false : a.subtype === 'contra_revenue' ? true : ['asset', 'expense', 'cogs'].includes(a.type));
const yearStart = (y) => new Date(Date.UTC(y, 0, 1));
const yearEnd = (y) => new Date(Date.UTC(y, 11, 31, 23, 59, 59, 999));

// ---- setting up the books -----------------------------------------------------------------------------
async function ensureYear(tx, context, year) {
  if (await tx.acctFiscalYear.findFirst({ where: { ...org(context), year } })) return;
  await tx.acctFiscalYear.create({ data: { ...org(context), year } });
  await tx.acctPeriod.createMany({ data: MONTHS.map((_, i) => ({ ...org(context), fiscalYear: year, month: i + 1 })), skipDuplicates: true });
}
/** The starter books, once per organization: chart, head office, this year's periods, settings, rules. */
export async function ensureBooks(tx, context) {
  if (await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } })) return;
  await tx.acctLedgerSettings.create({ data: { ...org(context), fxRates: STARTER_FX_RATES } });
  await tx.acctAccount.createMany({
    data: STARTER_CHART.map(([number, name, type, subtype, parentNumber]) => ({ ...org(context), number, name, type, subtype, parentNumber: parentNumber ?? null, allowManualEntry: !CONTROL_SUBTYPES.includes(subtype), system: true })),
    skipDuplicates: true,
  });
  await tx.acctBranch.create({ data: { ...org(context), code: 'HO', name: 'Head Office', isHeadOffice: true } });
  await ensureYear(tx, context, new Date().getUTCFullYear());
  await tx.acctApprovalRule.createMany({ data: STARTER_APPROVAL_RULES.map(({ id: _id, ...r }) => ({ ...org(context), ...r })) });
}
async function headOffice(tx, context) {
  return tx.acctBranch.findFirst({ where: { ...org(context), isHeadOffice: true } });
}

// ---- locks ------------------------------------------------------------------------------------------
export async function lockReason(tx, context, date) {
  const settings = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
  if (settings?.booksLockedBefore && date < settings.booksLockedBefore) return `The books are closed before ${settings.booksLockedBefore.toISOString().slice(0, 10)}.`;
  const period = await tx.acctPeriod.findFirst({ where: { ...org(context), fiscalYear: date.getUTCFullYear(), month: date.getUTCMonth() + 1 } });
  if (period?.status === 'Locked') return `${MONTHS[period.month - 1]} ${period.fiscalYear} is locked. Reopen it before posting to that date.`;
  return null;
}
async function requireOpen(tx, context, date) {
  const reason = await lockReason(tx, context, date);
  if (reason) throw new EmrError('BOOKS_LOCKED', { message: reason });
}

// ---- posting ----------------------------------------------------------------------------------------
async function checkLines(tx, context, lines, { manual }) {
  const clean = lines.map((l) => ({ ...l, debit: round2(l.debit || 0), credit: round2(l.credit || 0) })).filter((l) => l.debit !== 0 || l.credit !== 0);
  if (clean.length < 2) throw new EmrError('JOURNAL_UNBALANCED', { message: 'A journal entry needs at least two lines.' });
  const numbers = [...new Set(clean.map((l) => l.accountNumber))];
  const accounts = await tx.acctAccount.findMany({ where: { ...org(context), number: { in: numbers } } });
  for (const l of clean) {
    const a = accounts.find((x) => x.number === l.accountNumber);
    if (!a) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${l.accountNumber} does not exist.` });
    if (!a.isActive) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is archived.` });
    if (manual && !a.allowManualEntry) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is posted only by its subledger, not by a manual entry.` });
    if (l.debit < 0 || l.credit < 0) throw new EmrError('JOURNAL_UNBALANCED', { message: 'Amounts cannot be negative.' });
    if (l.debit > 0 && l.credit > 0) throw new EmrError('JOURNAL_UNBALANCED', { message: 'A line cannot be both a debit and a credit.' });
  }
  const debit = round2(clean.reduce((n, l) => n + l.debit, 0));
  const credit = round2(clean.reduce((n, l) => n + l.credit, 0));
  if (debit !== credit) throw new EmrError('JOURNAL_UNBALANCED', { message: `Out of balance by ${Math.abs(debit - credit).toFixed(2)} — debits ${debit.toFixed(2)}, credits ${credit.toFixed(2)}.` });
  if (debit === 0) throw new EmrError('JOURNAL_UNBALANCED', { message: 'A journal entry cannot be for zero.' });
  return clean;
}
const lineData = (context, entryId, lines) => lines.map((l, i) => ({
  ...org(context), entryId, lineNo: i + 1, accountNumber: l.accountNumber, debit: l.debit, credit: l.credit, description: l.description ?? null,
  costCenter: l.costCenter ?? null, customerId: l.customerId ?? null, vendorId: l.vendorId ?? null, projectId: l.projectId ?? null,
}));

/**
 * Writes a journal entry inside the caller's transaction (subledgers use this). `status`: Posted (default),
 * Draft or Pending Approval. `manual` keeps control accounts out of hand-made entries.
 */
export async function postEntry(tx, context, { id, date, source, memo, reference, lines, branchId, status = 'Posted', approvalRef, reversesEntryId, manual = false, skipLock = false }) {
  await ensureBooks(tx, context);
  const when = new Date(date);
  const clean = await checkLines(tx, context, lines, { manual });
  if (status === 'Posted' && !skipLock) await requireOpen(tx, context, when);
  const branch = branchId ? await tx.acctBranch.findFirst({ where: { ...org(context), id: branchId } }) : await headOffice(tx, context);
  if (!branch || !branch.active) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'That branch is not available.' });
  await ensureYear(tx, context, when.getUTCFullYear());
  const year = when.getUTCFullYear();
  const number = `JE-${year}-${String(await nextSequence(tx, context, `acct-je-${year}`)).padStart(6, '0')}`;
  const now = new Date();
  let entry;
  try {
    entry = await tx.acctJournalEntry.create({
      data: {
        ...(id ? { id } : {}), ...org(context), number, entryDate: when, branchId: branch.id, source, reference: reference ?? null, memo, status: 'Draft',
        createdByUserId: context.userId, approvalRef: approvalRef ?? null, reversesEntryId: reversesEntryId ?? null,
      },
    });
  } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE' }) ?? error; }
  // Lines are written while the entry is a draft; posting it then freezes them (the database enforces both).
  await tx.acctJournalLine.createMany({ data: lineData(context, entry.id, clean) });
  if (status !== 'Draft') {
    await tx.acctJournalEntry.updateMany({ where: { ...org(context), id: entry.id }, data: { status, ...(status === 'Posted' ? { postedByUserId: context.userId, postedAt: now } : {}) } });
    entry = { ...entry, status };
  }
  await audited(tx, context, status === 'Posted' ? 'journal.posted' : 'journal.drafted', 'journal_entry', entry.id, [source]);
  return entry;
}

/** Books the mirror image of a posted entry and marks the original reversed. */
export async function reverseInTx(tx, context, id, { date, memo } = {}) {
  const orig = await tx.acctJournalEntry.findFirst({ where: { ...org(context), id } });
  if (!orig) throw new EmrError('JOURNAL_NOT_FOUND');
  if (orig.status !== 'Posted') throw new EmrError('INVALID_STATE', { message: orig.status === 'Reversed' ? 'This entry has already been reversed.' : 'Only a posted entry can be reversed.' });
  const lines = await tx.acctJournalLine.findMany({ where: { ...org(context), entryId: id }, orderBy: { lineNo: 'asc' } });
  const reversal = await postEntry(tx, context, {
    date: date ?? new Date(), source: 'Reversal', reference: orig.number, memo: memo ?? `Reversal of ${orig.number} — ${orig.memo}`, branchId: orig.branchId, reversesEntryId: id,
    lines: lines.map((l) => ({ accountNumber: l.accountNumber, debit: Number(l.credit), credit: Number(l.debit), description: l.description, costCenter: l.costCenter, customerId: l.customerId, vendorId: l.vendorId, projectId: l.projectId })),
  });
  await updateVersioned(tx.acctJournalEntry, { organizationId: context.organizationId, id, expectedVersion: orig.version, data: { status: 'Reversed', reversedByEntryId: reversal.id }, notFoundCode: 'JOURNAL_NOT_FOUND' });
  await audited(tx, context, 'journal.reversed', 'journal_entry', id);
  return reversal;
}

// ---- balances ---------------------------------------------------------------------------------------
/** Debit and credit totals per account from posted lines, up to `asOf` (and from `from`), optionally one branch. */
export async function totalsByAccount(tx, context, { asOf, from, branchId } = {}) {
  const rows = await tx.$queryRaw`
    SELECT l."account_number" AS "number", COALESCE(SUM(l."debit"), 0) AS "debit", COALESCE(SUM(l."credit"), 0) AS "credit"
    FROM "acct_journal_lines" l JOIN "acct_journal_entries" e ON e."organization_id" = l."organization_id" AND e."id" = l."entry_id"
    WHERE e."status" IN ('Posted', 'Reversed')
      AND (${asOf ?? null}::timestamp IS NULL OR e."entry_date" <= ${asOf ?? null}::timestamp)
      AND (${from ?? null}::timestamp IS NULL OR e."entry_date" >= ${from ?? null}::timestamp)
      AND (${branchId ?? null}::text IS NULL OR e."branch_id" = ${branchId ?? null}::text)
    GROUP BY l."account_number"`;
  return new Map(rows.map((r) => [Number(r.number), { debit: round2(r.debit), credit: round2(r.credit) }]));
}
export async function trialBalance(context, { asOf, branchId }) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const [accounts, totals] = await Promise.all([tx.acctAccount.findMany({ where: org(context), orderBy: { number: 'asc' } }), totalsByAccount(tx, context, { asOf: asOf ? new Date(asOf) : undefined, branchId })]);
    const rows = [];
    for (const a of accounts) {
      const t = totals.get(a.number);
      if (!t) continue;
      const bal = round2(isDebitNormal(a) ? t.debit - t.credit : t.credit - t.debit);
      const debit = isDebitNormal(a) ? Math.max(bal, 0) : Math.max(-bal, 0);
      const credit = isDebitNormal(a) ? Math.max(-bal, 0) : Math.max(bal, 0);
      if (debit > 0.005 || credit > 0.005) rows.push({ number: a.number, name: a.name, debit: round2(debit), credit: round2(credit) });
    }
    const debit = round2(rows.reduce((n, r) => n + r.debit, 0));
    const credit = round2(rows.reduce((n, r) => n + r.credit, 0));
    return { rows, debit, credit, inBalance: debit === credit };
  });
}

// ---- reading ----------------------------------------------------------------------------------------
const presentAccount = (a) => ({
  id: a.id, number: a.number, name: a.name, type: a.type, subtype: a.subtype, parentNumber: a.parentNumber ?? undefined, description: a.description ?? undefined,
  isActive: a.isActive, allowManualEntry: a.allowManualEntry, openingBalance: 0, currency: a.currency, system: a.system || undefined, version: a.version,
});
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const [accounts, branches, groups, years, periods, settings, entries, lines, recurring, closings, rules] = await Promise.all([
      tx.acctAccount.findMany({ where: org(context), orderBy: { number: 'asc' } }),
      tx.acctBranch.findMany({ where: org(context), orderBy: { createdAt: 'asc' } }),
      tx.acctConsolidationGroup.findMany({ where: org(context) }),
      tx.acctFiscalYear.findMany({ where: org(context), orderBy: { year: 'asc' } }),
      tx.acctPeriod.findMany({ where: org(context), orderBy: [{ fiscalYear: 'asc' }, { month: 'asc' }] }),
      tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } }),
      tx.acctJournalEntry.findMany({ where: org(context), orderBy: [{ entryDate: 'desc' }, { number: 'desc' }] }),
      tx.acctJournalLine.findMany({ where: org(context), orderBy: { lineNo: 'asc' } }),
      tx.acctRecurringJournal.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.acctYearEndClosing.findMany({ where: org(context), orderBy: { year: 'desc' } }),
      tx.acctApprovalRule.findMany({ where: org(context), orderBy: [{ docType: 'asc' }, { level: 'asc' }] }),
    ]);
    const names = await userNameMap(tx, entries.flatMap((e) => [e.createdByUserId, e.postedByUserId]));
    const byEntry = new Map();
    for (const l of lines) byEntry.set(l.entryId, [...(byEntry.get(l.entryId) ?? []), l]);
    const now = new Date();
    return {
      accounts: accounts.map(presentAccount),
      branches: branches.map((b) => ({ id: b.id, code: b.code, name: b.name, isHeadOffice: b.isHeadOffice, baseCurrency: b.baseCurrency, active: b.active })),
      consolidationGroups: groups.map((g) => ({ id: g.id, name: g.name, branchIds: g.branchIds, eliminate: g.eliminate })),
      fiscalYears: years.map((y) => ({ id: y.id, year: y.year, startDate: yearStart(y.year).toISOString(), endDate: yearEnd(y.year).toISOString(), status: y.status })),
      periods: periods.map((p) => {
        const start = new Date(Date.UTC(p.fiscalYear, p.month - 1, 1));
        const end = new Date(Date.UTC(p.fiscalYear, p.month, 0, 23, 59, 59, 999));
        return { id: p.id, fiscalYear: p.fiscalYear, month: p.month, label: `${MONTHS[p.month - 1]} ${p.fiscalYear}`, startDate: start.toISOString(), endDate: end.toISOString(), status: p.status, isCurrent: start <= now && now <= end };
      }),
      booksLockedBefore: settings.booksLockedBefore?.toISOString() ?? null,
      fxRates: settings.fxRates, settingsVersion: settings.version,
      entries: entries.map((e) => ({
        id: e.id, number: e.number, date: e.entryDate.toISOString(), branchId: e.branchId, source: e.source, reference: e.reference ?? undefined, memo: e.memo, status: e.status,
        createdBy: names.get(e.createdByUserId) ?? 'Former member', createdAt: e.createdAt, postedBy: e.postedByUserId ? names.get(e.postedByUserId) ?? 'Former member' : undefined, postedAt: e.postedAt ?? undefined,
        reversedByEntryId: e.reversedByEntryId ?? undefined, reversesEntryId: e.reversesEntryId ?? undefined, approvalRef: e.approvalRef ?? undefined, version: e.version,
        lines: (byEntry.get(e.id) ?? []).map((l) => ({
          id: l.id, accountNumber: l.accountNumber, debit: Number(l.debit), credit: Number(l.credit), description: l.description ?? undefined, costCenter: l.costCenter ?? undefined,
          customerId: l.customerId ?? undefined, vendorId: l.vendorId ?? undefined, projectId: l.projectId ?? undefined,
        })),
      })),
      recurringJournals: recurring.map((r) => ({ id: r.id, memo: r.memo, lines: r.lines, everyMonths: r.everyMonths, nextDate: r.nextDate.toISOString(), endDate: r.endDate?.toISOString(), lastPostedDate: r.lastPostedDate?.toISOString(), postedCount: r.postedCount, active: r.active, createdAt: r.createdAt, version: r.version })),
      yearEndClosings: closings.map((c) => ({ year: c.year, closedAt: c.closedAt, closedBy: c.closedByUserId, netIncome: Number(c.netIncome), journalEntryId: c.journalEntryId })),
      approvalRules: rules.map((r) => ({ id: r.id, docType: r.docType, minAmount: Number(r.minAmount), maxAmount: r.maxAmount === null ? null : Number(r.maxAmount), approverRole: r.approverRole, level: r.level, active: r.active, version: r.version })),
    };
  });
}

// ---- journal entries --------------------------------------------------------------------------------
export async function createEntry(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const entry = await postEntry(tx, context, { ...input, source: 'Manual', manual: true, status: input.status ?? 'Posted' });
    return { id: entry.id, number: entry.number, status: entry.status };
  });
}
async function draftOf(tx, context, id) {
  const e = await tx.acctJournalEntry.findFirst({ where: { ...org(context), id } });
  if (!e) throw new EmrError('JOURNAL_NOT_FOUND');
  if (e.status !== 'Draft') throw new EmrError('INVALID_STATE', { message: 'Only a draft can be changed.' });
  return e;
}
export async function updateDraft(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await draftOf(tx, context, id);
    if (patch.lines) {
      const clean = await checkLines(tx, context, patch.lines, { manual: true });
      await tx.acctJournalLine.deleteMany({ where: { ...org(context), entryId: id } });
      await tx.acctJournalLine.createMany({ data: lineData(context, id, clean) });
    }
    const data = Object.fromEntries(Object.entries({ entryDate: patch.date ? new Date(patch.date) : undefined, memo: patch.memo, reference: patch.reference }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctJournalEntry, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'JOURNAL_NOT_FOUND' });
    await audited(tx, context, 'journal.draft_updated', 'journal_entry', id, Object.keys(data).concat(patch.lines ? ['lines'] : []));
    return { id };
  });
}
export async function postDraft(context, id, expectedVersion) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const e = await draftOf(tx, context, id);
    const lines = await tx.acctJournalLine.findMany({ where: { ...org(context), entryId: id } });
    await checkLines(tx, context, lines.map((l) => ({ accountNumber: l.accountNumber, debit: Number(l.debit), credit: Number(l.credit) })), { manual: e.source === 'Manual' });
    await requireOpen(tx, context, e.entryDate);
    await updateVersioned(tx.acctJournalEntry, { organizationId: context.organizationId, id, expectedVersion, data: { status: 'Posted', postedByUserId: context.userId, postedAt: new Date() }, notFoundCode: 'JOURNAL_NOT_FOUND' });
    await audited(tx, context, 'journal.posted', 'journal_entry', id);
    return { id, status: 'Posted' };
  });
}
export async function voidEntry(context, id, expectedVersion) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const e = await tx.acctJournalEntry.findFirst({ where: { ...org(context), id } });
    if (!e) throw new EmrError('JOURNAL_NOT_FOUND');
    if (!['Draft', 'Pending Approval'].includes(e.status)) throw new EmrError('INVALID_STATE', { message: 'A posted entry is reversed, not voided.' });
    await updateVersioned(tx.acctJournalEntry, { organizationId: context.organizationId, id, expectedVersion, data: { status: 'Void' }, notFoundCode: 'JOURNAL_NOT_FOUND' });
    await audited(tx, context, 'journal.voided', 'journal_entry', id);
    return { id, status: 'Void' };
  });
}
export async function reverseEntry(context, id, { date, memo }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const reversal = await reverseInTx(tx, context, id, { date: date ? new Date(date) : undefined, memo });
    return { id: reversal.id, number: reversal.number };
  });
}

// ---- chart of accounts ------------------------------------------------------------------------------
export async function addAccountInTx(tx, context, a) {
  if (await tx.acctAccount.findFirst({ where: { ...org(context), number: a.number } })) throw new EmrError('ACCOUNT_IN_USE', { message: `Account ${a.number} already exists.` });
  if (a.parentNumber && !(await tx.acctAccount.findFirst({ where: { ...org(context), number: a.parentNumber } }))) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Parent account ${a.parentNumber} does not exist.` });
  await tx.acctAccount.create({
    data: { ...org(context), number: a.number, name: a.name, type: a.type, subtype: a.subtype, parentNumber: a.parentNumber ?? null, description: a.description ?? null, allowManualEntry: a.allowManualEntry ?? !CONTROL_SUBTYPES.includes(a.subtype) },
  });
  // A non-zero opening balance is a real journal entry against Opening Balance Equity (3900).
  const opening = round2(a.openingBalance ?? 0);
  if (opening !== 0) {
    const settings = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
    const debitNormal = isDebitNormal(a);
    await postEntry(tx, context, {
      date: settings.booksLockedBefore ?? new Date(), source: 'Opening Balance', memo: `Opening balance — ${a.number} ${a.name}`, skipLock: true,
      lines: debitNormal === opening > 0
        ? [{ accountNumber: a.number, debit: Math.abs(opening), credit: 0 }, { accountNumber: 3900, debit: 0, credit: Math.abs(opening) }]
        : [{ accountNumber: 3900, debit: Math.abs(opening), credit: 0 }, { accountNumber: a.number, debit: 0, credit: Math.abs(opening) }],
    });
  }
  await audited(tx, context, 'account.created', 'account', String(a.number));
}
export async function addAccount(context, a) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    await addAccountInTx(tx, context, a);
    return { number: a.number };
  });
}
export async function applyTemplate(context, templateId) {
  requireAcct(context, 'acct.control');
  const tmpl = COA_TEMPLATES.find((t) => t.id === templateId);
  if (!tmpl) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Unknown chart template.' });
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const have = new Set((await tx.acctAccount.findMany({ where: org(context), select: { number: true } })).map((a) => a.number));
    let added = 0;
    for (const t of tmpl.accounts) {
      if (have.has(t.number)) continue;
      await addAccountInTx(tx, context, { ...t, parentNumber: t.parentNumber && have.has(t.parentNumber) ? t.parentNumber : undefined });
      have.add(t.number);
      added += 1;
    }
    await audited(tx, context, 'account.template_applied', 'account', null, [templateId, String(added)]);
    return { added, skipped: tmpl.accounts.length - added };
  });
}
export async function importAccounts(context, rows) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    let added = 0;
    const errors = [];
    for (const [i, r] of rows.entries()) {
      try {
        await tx.$executeRawUnsafe('SAVEPOINT acct_import');
        await addAccountInTx(tx, context, r);
        await tx.$executeRawUnsafe('RELEASE SAVEPOINT acct_import');
        added += 1;
      } catch (error) {
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT acct_import');
        errors.push(`Row ${i + 2}: ${error.publicMessage ?? error.message}`);
      }
    }
    return { added, errors };
  });
}
export async function updateAccount(context, number, expectedVersion, patch) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const a = await tx.acctAccount.findFirst({ where: { ...org(context), number } });
    if (!a) throw new EmrError('ACCOUNT_NOT_FOUND');
    if (patch.parentNumber === number) throw new EmrError('VALIDATION_FAILED', { message: 'An account cannot be its own parent.' });
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctAccount, { organizationId: context.organizationId, id: a.id, expectedVersion, data, notFoundCode: 'ACCOUNT_NOT_FOUND' });
    await audited(tx, context, data.isActive === false ? 'account.archived' : 'account.updated', 'account', String(number), Object.keys(data));
    return { number };
  });
}

// ---- branches ---------------------------------------------------------------------------------------
export async function addBranch(context, { id, code, name }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    let b;
    try { b = await tx.acctBranch.create({ data: { ...(id ? { id } : {}), ...org(context), code: code.toUpperCase(), name } }); } catch (error) { throw uniqueViolation(error, { code_key: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'branch.created', 'branch', b.id);
    return { id: b.id };
  });
}
export async function addConsolidationGroup(context, { id, name, branchIds }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const found = await tx.acctBranch.count({ where: { ...org(context), id: { in: branchIds } } });
    if (found !== new Set(branchIds).size) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Unknown branch in the group.' });
    const g = await tx.acctConsolidationGroup.create({ data: { ...(id ? { id } : {}), ...org(context), name, branchIds, eliminate: [{ receivable: 1150, payable: 2150 }] } });
    await audited(tx, context, 'consolidation_group.created', 'consolidation_group', g.id);
    return { id: g.id };
  });
}

// ---- fiscal calendar --------------------------------------------------------------------------------
export async function setPeriodStatus(context, id, { status }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    const p = await tx.acctPeriod.findFirst({ where: { ...org(context), id } });
    if (!p) throw new EmrError('HR_RECORD_NOT_FOUND');
    const year = await tx.acctFiscalYear.findFirst({ where: { ...org(context), year: p.fiscalYear } });
    if (year?.status === 'Closed' && status !== 'Locked') throw new EmrError('INVALID_STATE', { message: `${p.fiscalYear} is closed; its periods stay locked.` });
    await tx.acctPeriod.updateMany({ where: { ...org(context), id }, data: { status } });
    await audited(tx, context, `period.${status.toLowerCase()}`, 'period', id);
    return { id, status };
  });
}
export async function setBooksLock(context, expectedVersion, { booksLockedBefore }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const closed = await tx.acctYearEndClosing.findFirst({ where: org(context), orderBy: { year: 'desc' } });
    const date = booksLockedBefore ? new Date(booksLockedBefore) : null;
    if (closed && (!date || date < yearStart(closed.year + 1))) throw new EmrError('INVALID_STATE', { message: `${closed.year} is closed; the books stay locked up to its year end.` });
    const { count } = await tx.acctLedgerSettings.updateMany({ where: { ...org(context), version: expectedVersion }, data: { booksLockedBefore: date, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
    if (!count) throw new EmrError('VERSION_CONFLICT');
    await audited(tx, context, date ? 'books.locked' : 'books.unlocked', 'ledger', null);
    return { booksLockedBefore: date?.toISOString() ?? null };
  });
}
export async function setFxRates(context, expectedVersion, { fxRates }) {
  requireAcct(context, 'acct.control');
  if (!fxRates.some((r) => r.code === 'NGN' && r.rateToNgn === 1)) throw new EmrError('VALIDATION_FAILED', { message: 'The naira (NGN) stays at a rate of 1.' });
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const { count } = await tx.acctLedgerSettings.updateMany({ where: { ...org(context), version: expectedVersion }, data: { fxRates, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
    if (!count) throw new EmrError('VERSION_CONFLICT');
    await audited(tx, context, 'fx_rates.updated', 'ledger', null, fxRates.map((r) => r.code));
    return { saved: true };
  });
}
export async function openFiscalYear(context, { year }) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    if (await tx.acctFiscalYear.findFirst({ where: { ...org(context), year } })) throw new EmrError('INVALID_STATE', { message: `${year} is already open.` });
    await ensureYear(tx, context, year);
    await audited(tx, context, 'fiscal_year.opened', 'fiscal_year', String(year));
    return { year };
  });
}

/** The closing entry for a year: each P&L account's activity for the year, closed to Retained Earnings. */
async function closingLines(tx, context, year) {
  const [accounts, totals] = await Promise.all([
    tx.acctAccount.findMany({ where: { ...org(context), type: { in: ['revenue', 'expense', 'cogs'] } } }),
    totalsByAccount(tx, context, { from: yearStart(year), asOf: yearEnd(year) }),
  ]);
  const lines = [];
  let net = 0;
  for (const a of accounts) {
    const t = totals.get(a.number);
    if (!t) continue;
    const bal = round2(isDebitNormal(a) ? t.debit - t.credit : t.credit - t.debit);
    if (Math.abs(bal) < 0.005) continue;
    // post the opposite of each account's balance
    if (isDebitNormal(a)) { lines.push(bal > 0 ? { accountNumber: a.number, name: a.name, debit: 0, credit: bal } : { accountNumber: a.number, name: a.name, debit: -bal, credit: 0 }); net -= bal; }
    else { lines.push(bal > 0 ? { accountNumber: a.number, name: a.name, debit: bal, credit: 0 } : { accountNumber: a.number, name: a.name, debit: 0, credit: -bal }); net += bal; }
  }
  net = round2(net);
  if (lines.length) lines.push(net >= 0 ? { accountNumber: 3200, name: 'Retained Earnings', debit: 0, credit: net } : { accountNumber: 3200, name: 'Retained Earnings', debit: -net, credit: 0 });
  return { lines: lines.filter((l) => l.debit > 0 || l.credit > 0), netIncome: net };
}
async function closeCheck(tx, context, year) {
  if (await tx.acctYearEndClosing.findFirst({ where: { ...org(context), year } })) return `${year} is already closed.`;
  const earlier = await tx.acctFiscalYear.findMany({ where: { ...org(context), year: { lt: year }, status: 'Open' } });
  for (const y of earlier) if ((await closingLines(tx, context, y.year)).lines.length) return 'Close the earlier open year first.';
  return null;
}
export async function previewYearEnd(context, year) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const { lines, netIncome } = await closingLines(tx, context, year);
    const reason = (await closeCheck(tx, context, year)) ?? (lines.length ? null : 'No P&L activity to close.');
    return { lines, netIncome, canClose: !reason, reason: reason ?? undefined };
  });
}
export async function closeYear(context, year) {
  requireAcct(context, 'acct.control');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const reason = await closeCheck(tx, context, year);
    if (reason) throw new EmrError('INVALID_STATE', { message: reason });
    const { lines, netIncome } = await closingLines(tx, context, year);
    if (!lines.length) throw new EmrError('INVALID_STATE', { message: 'No P&L activity to close.' });
    // The closing entry lands on the year-end date itself, even if that month is already locked.
    const entry = await postEntry(tx, context, { date: new Date(Date.UTC(year, 11, 31, 12)), source: 'Year-End Close', reference: `FY${year}`, memo: `Year-end close ${year} — P&L accounts to Retained Earnings`, skipLock: true, lines: lines.map((l) => ({ ...l, description: `Close ${l.name}` })) });
    await tx.acctYearEndClosing.create({ data: { ...org(context), year, closedByUserId: context.userId, netIncome, journalEntryId: entry.id } });
    await tx.acctPeriod.updateMany({ where: { ...org(context), fiscalYear: year }, data: { status: 'Locked' } });
    await tx.acctFiscalYear.updateMany({ where: { ...org(context), year }, data: { status: 'Closed' } });
    const settings = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
    const lockTo = yearStart(year + 1);
    if (!settings.booksLockedBefore || settings.booksLockedBefore < lockTo) await tx.acctLedgerSettings.updateMany({ where: org(context), data: { booksLockedBefore: lockTo, version: { increment: 1 } } });
    await ensureYear(tx, context, year + 1);
    await audited(tx, context, 'fiscal_year.closed', 'fiscal_year', String(year), [String(netIncome)]);
    return { year, netIncome, journalEntryId: entry.id };
  });
}

// ---- recurring journals -----------------------------------------------------------------------------
const monthsForward = (d, m) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m, d.getUTCDate(), 12));
export async function addRecurring(context, { id, memo, lines, everyMonths, startDate, endDate }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const clean = await checkLines(tx, context, lines, { manual: true });
    const ho = await headOffice(tx, context);
    const r = await tx.acctRecurringJournal.create({ data: { ...(id ? { id } : {}), ...org(context), memo, lines: clean, everyMonths, nextDate: new Date(startDate), endDate: endDate ? new Date(endDate) : null, branchId: ho.id, createdByUserId: context.userId } });
    await audited(tx, context, 'recurring_journal.created', 'recurring_journal', r.id);
    return { id: r.id };
  });
}
export async function updateRecurring(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const data = Object.fromEntries(Object.entries({ ...patch, endDate: patch.endDate === undefined ? undefined : patch.endDate ? new Date(patch.endDate) : null }).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctRecurringJournal, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'recurring_journal.updated', 'recurring_journal', id, Object.keys(data));
    return { id };
  });
}
export async function runRecurring(context, { asOf }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const when = new Date(asOf);
    const due = await tx.acctRecurringJournal.findMany({ where: { ...org(context), active: true, nextDate: { lte: when } } });
    let posted = 0;
    const skipped = [];
    for (const r of due) {
      let next = r.nextDate;
      let count = r.postedCount;
      let last = r.lastPostedDate;
      while (next <= when && (!r.endDate || next <= r.endDate)) {
        const reason = await lockReason(tx, context, next);
        if (reason) { skipped.push(`${r.memo}: ${reason}`); break; }
        await postEntry(tx, context, { date: next, source: 'Manual', memo: `${r.memo} (recurring)`, reference: r.id, branchId: r.branchId, lines: r.lines, manual: true });
        posted += 1; count += 1; last = next;
        next = monthsForward(next, r.everyMonths);
      }
      const ended = r.endDate && next > r.endDate;
      await updateVersioned(tx.acctRecurringJournal, { organizationId: context.organizationId, id: r.id, expectedVersion: r.version, data: { nextDate: next, postedCount: count, lastPostedDate: last, ...(ended ? { active: false } : {}) }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    }
    if (posted) await audited(tx, context, 'recurring_journal.run', 'recurring_journal', null, [String(posted)]);
    return { posted, skipped };
  });
}
