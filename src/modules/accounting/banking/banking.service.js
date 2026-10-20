// Banking: bank and cash accounts, transfers and bank-only transactions, imported statement lines,
// reconciliation rules and bank reconciliations.
//
// Rules enforced here:
//   - a bank account is a ledger account of subtype bank or cash; transfers and bank transactions post
//     through the ledger as manual entries, so control accounts (receivables, payables) stay with their
//     subledgers;
//   - a statement line is booked or matched once; booking it posts the entry and clears it;
//   - one reconciliation is in progress per account; only that account's posted movements up to the
//     statement date can be cleared, and it completes only when the cleared balance meets the statement;
//   - live bank feeds need an open-banking provider: none is configured, so connecting or syncing one is
//     refused rather than simulated;
//   - acct.view reads; acct.post records, imports, matches and reconciles; adding a ledger account for a new
//     bank is the controller's (it changes the chart).
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { addAccountInTx, ensureBooks, postEntry, requireAcct, round2 } from '../ledger/ledger.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const notFound = (what) => new EmrError('HR_RECORD_NOT_FOUND', { message: `${what} not found.` });
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const BANK_SUBTYPES = ['bank', 'cash'];
const iso = (d) => (d ? d.toISOString() : undefined);

async function bankAccount(tx, context, number) {
  const a = await tx.acctAccount.findFirst({ where: { ...org(context), number } });
  if (!a || !BANK_SUBTYPES.includes(a.subtype)) throw new EmrError('VALIDATION_FAILED', { message: `Account ${number} is not a bank or cash account.` });
  if (!a.isActive) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is archived.` });
  return a;
}
/** Posted movements on a bank account up to a date, keyed "entryId:lineId" (what a reconciliation clears). */
async function movements(tx, context, accountNumber, asOf) {
  const entries = await tx.acctJournalEntry.findMany({ where: { ...org(context), status: { in: ['Posted', 'Reversed'] }, ...(asOf ? { entryDate: { lte: asOf } } : {}) }, select: { id: true } });
  if (!entries.length) return [];
  const lines = await tx.acctJournalLine.findMany({ where: { ...org(context), accountNumber, entryId: { in: entries.map((e) => e.id) } }, select: { id: true, entryId: true, debit: true, credit: true } });
  return lines.map((l) => ({ key: `${l.entryId}:${l.id}`, amount: round2(Number(l.debit) - Number(l.credit)) }));
}
async function bookLine(tx, context, { accountNumber, contraAccount, direction, amount, date, description, reference }) {
  await bankAccount(tx, context, accountNumber);
  if (contraAccount === accountNumber) throw new EmrError('VALIDATION_FAILED', { message: 'Pick a different account to post against.' });
  const bank = { accountNumber, debit: direction === 'in' ? amount : 0, credit: direction === 'in' ? 0 : amount, description };
  const contra = { accountNumber: contraAccount, debit: direction === 'in' ? 0 : amount, credit: direction === 'in' ? amount : 0, description };
  const entry = await postEntry(tx, context, { date, source: 'Bank Transaction', memo: description, reference, lines: [bank, contra], manual: true });
  const line = await tx.acctJournalLine.findFirst({ where: { ...org(context), entryId: entry.id, accountNumber }, select: { id: true } });
  return { entry, key: `${entry.id}:${line.id}` };
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const [accounts, metas, lines, recons, rules] = await Promise.all([
      tx.acctAccount.findMany({ where: { ...org(context), subtype: { in: BANK_SUBTYPES } }, orderBy: { number: 'asc' } }),
      tx.acctBankAccount.findMany({ where: org(context) }),
      tx.acctStatementLine.findMany({ where: org(context), orderBy: [{ lineDate: 'desc' }, { importedAt: 'desc' }] }),
      tx.acctReconciliation.findMany({ where: org(context), orderBy: { statementDate: 'desc' } }),
      tx.acctReconciliationRule.findMany({ where: org(context), orderBy: { createdAt: 'asc' } }),
    ]);
    const names = await userNameMap(tx, recons.map((r) => r.completedByUserId));
    const metaOf = new Map(metas.map((m) => [m.accountNumber, m]));
    return {
      // every bank or cash ledger account; the bank's details where they have been recorded
      accounts: accounts.map((a) => {
        const m = metaOf.get(a.number);
        return m
          ? { id: m.id, accountNumber: a.number, bankName: m.bankName, accountName: m.accountName, accountNo: m.accountNo, currency: m.currency, sortCode: m.sortCode ?? undefined, active: m.active && a.isActive, version: m.version }
          : { id: `gl-${a.number}`, accountNumber: a.number, bankName: a.subtype === 'cash' ? 'Cash' : '', accountName: a.name, accountNo: '—', currency: 'NGN', active: a.isActive };
      }),
      statementLines: lines.map((l) => ({
        id: l.id, accountNumber: l.accountNumber, date: iso(l.lineDate), description: l.description, amount: Number(l.amount), reference: l.reference ?? undefined, reconciled: l.reconciled,
        matchedJournalEntryId: l.matchedJournalEntryId ?? undefined, importedAt: iso(l.importedAt), origin: l.origin, ruleApplied: l.ruleApplied ?? undefined,
      })),
      reconciliations: recons.map((r) => ({
        id: r.id, accountNumber: r.accountNumber, statementDate: iso(r.statementDate), openingBalance: Number(r.openingBalance), closingBalance: Number(r.closingBalance), status: r.status,
        reconciledLineIds: r.clearedKeys, completedAt: iso(r.completedAt), completedBy: r.completedByUserId ? names.get(r.completedByUserId) ?? 'Former member' : undefined, version: r.version,
      })),
      reconciliationRules: rules.map((r) => ({
        id: r.id, accountNumber: r.accountNumber, name: r.name, descriptionContains: r.descriptionContains ?? undefined, direction: r.direction ?? undefined, contraAccount: r.contraAccount, memo: r.memo ?? undefined, active: r.active, version: r.version,
      })),
      connections: [],
      feedProvider: null, // no open-banking provider is configured
    };
  });
}

// ---- accounts ---------------------------------------------------------------------------------------
/** Records a bank's details; creates the ledger account too when the number is new (the controller's). */
export async function addBankAccount(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const existing = await tx.acctAccount.findFirst({ where: { ...org(context), number: input.number } });
    if (existing) {
      if (!BANK_SUBTYPES.includes(existing.subtype)) throw new EmrError('ACCOUNT_IN_USE', { message: `Account ${input.number} already exists and is not a bank or cash account.` });
    } else {
      requireAcct(context, 'acct.control');
      await addAccountInTx(tx, context, { number: input.number, name: input.name, type: 'asset', subtype: input.subtype, openingBalance: input.openingBalance ?? 0, allowManualEntry: true });
    }
    try {
      const m = await tx.acctBankAccount.create({ data: { ...org(context), accountNumber: input.number, bankName: input.bankName, accountName: input.accountName, accountNo: input.accountNo, currency: input.currency ?? 'NGN', sortCode: input.sortCode ?? null } });
      await audited(tx, context, 'bank_account.added', 'bank_account', m.id);
      return { id: m.id };
    } catch (error) { throw uniqueViolation(error, { number_key: 'ACCOUNT_IN_USE' }) ?? error; }
  });
}
export async function updateBankAccount(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctBankAccount, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'bank_account.updated', 'bank_account', id, Object.keys(data));
    return { id };
  });
}

// ---- transfers and bank transactions ----------------------------------------------------------------
export async function recordTransfer(context, { id, fromAccount, toAccount, amount, date, reference, note }) {
  requireAcct(context, 'acct.post');
  if (fromAccount === toAccount) throw new EmrError('VALIDATION_FAILED', { message: 'Pick two different accounts.' });
  return withTenant(context, async (tx) => {
    const from = await bankAccount(tx, context, fromAccount);
    const to = await bankAccount(tx, context, toAccount);
    const entry = await postEntry(tx, context, {
      id, date, source: 'Bank Transaction', memo: note || `Transfer — ${from.name} → ${to.name}`, reference, manual: true,
      lines: [{ accountNumber: to.number, debit: amount, credit: 0, description: 'Transfer in' }, { accountNumber: from.number, debit: 0, credit: amount, description: 'Transfer out' }],
    });
    return { id: entry.id, number: entry.number };
  });
}
export async function recordBankLine(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const { entry } = await bookLine(tx, context, input);
    return { id: entry.id, number: entry.number };
  });
}

// ---- statement lines --------------------------------------------------------------------------------
export async function importStatementLines(context, { accountNumber, lines }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await bankAccount(tx, context, accountNumber);
    const rows = lines.filter((l) => round2(l.amount) !== 0).map((l) => ({ ...org(context), accountNumber, lineDate: new Date(l.date), description: l.description, amount: round2(l.amount), reference: l.reference ?? null, importedByUserId: context.userId }));
    if (!rows.length) throw new EmrError('VALIDATION_FAILED', { message: 'The statement has no lines with an amount.' });
    await tx.acctStatementLine.createMany({ data: rows });
    await audited(tx, context, 'bank_statement.imported', 'bank_account', String(accountNumber), [String(rows.length)]);
    return { imported: rows.length };
  });
}
async function lineOf(tx, context, id) {
  const l = await tx.acctStatementLine.findFirst({ where: { ...org(context), id } });
  if (!l) throw notFound('Statement line');
  if (l.reconciled) throw new EmrError('INVALID_STATE', { message: 'This statement line has already been cleared.' });
  return l;
}
async function addToOpenRecon(tx, context, accountNumber, key) {
  const open = await tx.acctReconciliation.findFirst({ where: { ...org(context), accountNumber, status: 'In Progress' } });
  if (open && !open.clearedKeys.includes(key)) await updateVersioned(tx.acctReconciliation, { organizationId: context.organizationId, id: open.id, expectedVersion: open.version, data: { clearedKeys: [...open.clearedKeys, key] } });
}
/** Clears a statement line against a posted entry that already moved this account. */
export async function matchStatementLine(context, id, { matchedJournalEntryId }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const l = await lineOf(tx, context, id);
    if (matchedJournalEntryId) {
      const entry = await tx.acctJournalEntry.findFirst({ where: { ...org(context), id: matchedJournalEntryId, status: 'Posted' } });
      const touches = entry && (await tx.acctJournalLine.findFirst({ where: { ...org(context), entryId: entry.id, accountNumber: l.accountNumber } }));
      if (!touches) throw new EmrError('VALIDATION_FAILED', { message: 'That entry does not move this bank account.' });
    }
    await tx.acctStatementLine.updateMany({ where: { ...org(context), id }, data: { reconciled: true, matchedJournalEntryId: matchedJournalEntryId ?? null } });
    await audited(tx, context, 'bank_statement.line_matched', 'statement_line', id);
    return { id };
  });
}
/** Books a bank-only statement line (charges, POS settlements…) against an account, and clears it. */
export async function bookStatementLine(context, id, { contraAccount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const l = await lineOf(tx, context, id);
    const amount = Number(l.amount);
    const { entry, key } = await bookLine(tx, context, { accountNumber: l.accountNumber, contraAccount, direction: amount >= 0 ? 'in' : 'out', amount: Math.abs(amount), date: l.lineDate, description: l.description, reference: l.reference ?? undefined });
    await tx.acctStatementLine.updateMany({ where: { ...org(context), id }, data: { reconciled: true, matchedJournalEntryId: entry.id } });
    await addToOpenRecon(tx, context, l.accountNumber, key);
    return { id, journalEntryId: entry.id };
  });
}

// ---- reconciliation rules ---------------------------------------------------------------------------
async function checkRule(tx, context, r) {
  if (r.accountNumber !== undefined) await bankAccount(tx, context, r.accountNumber);
  if (r.contraAccount !== undefined) {
    const a = await tx.acctAccount.findFirst({ where: { ...org(context), number: r.contraAccount } });
    if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${r.contraAccount} is not available.` });
    if (!a.allowManualEntry) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is posted only by its subledger.` });
  }
}
export async function addRule(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await checkRule(tx, context, input);
    const r = await tx.acctReconciliationRule.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), accountNumber: input.accountNumber, name: input.name, descriptionContains: input.descriptionContains ?? null, direction: input.direction ?? null, contraAccount: input.contraAccount, memo: input.memo ?? null } });
    await audited(tx, context, 'bank_rule.added', 'bank_rule', r.id);
    return { id: r.id };
  });
}
export async function updateRule(context, id, expectedVersion, patch) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await checkRule(tx, context, { contraAccount: patch.contraAccount });
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.acctReconciliationRule, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'bank_rule.updated', 'bank_rule', id, Object.keys(data));
    return { id };
  });
}
/** Books every uncleared statement line on an account that one of its active rules covers. */
export async function applyRules(context, accountNumber) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await bankAccount(tx, context, accountNumber);
    const rules = await tx.acctReconciliationRule.findMany({ where: { ...org(context), accountNumber, active: true }, orderBy: { createdAt: 'asc' } });
    const lines = await tx.acctStatementLine.findMany({ where: { ...org(context), accountNumber, reconciled: false }, orderBy: { lineDate: 'asc' } });
    let matched = 0;
    for (const l of lines) {
      const amount = Number(l.amount);
      const rule = rules.find((r) => (!r.descriptionContains || l.description.toUpperCase().includes(r.descriptionContains.toUpperCase())) && (r.direction !== 'in' || amount > 0) && (r.direction !== 'out' || amount < 0));
      if (!rule) continue;
      const { entry, key } = await bookLine(tx, context, { accountNumber, contraAccount: rule.contraAccount, direction: amount >= 0 ? 'in' : 'out', amount: Math.abs(amount), date: l.lineDate, description: rule.memo ?? l.description, reference: l.reference ?? undefined });
      await tx.acctStatementLine.updateMany({ where: { ...org(context), id: l.id }, data: { reconciled: true, matchedJournalEntryId: entry.id, ruleApplied: rule.id } });
      await addToOpenRecon(tx, context, accountNumber, key);
      matched += 1;
    }
    if (matched) await audited(tx, context, 'bank_rule.applied', 'bank_account', String(accountNumber), [String(matched)]);
    return { matched };
  });
}

// ---- reconciliations --------------------------------------------------------------------------------
export async function startReconciliation(context, { id, accountNumber, statementDate, closingBalance }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await bankAccount(tx, context, accountNumber);
    // opening = where the last completed reconciliation of this account left off
    const prior = await tx.acctReconciliation.findFirst({ where: { ...org(context), accountNumber, status: 'Reconciled' }, orderBy: { statementDate: 'desc' } });
    try {
      const r = await tx.acctReconciliation.create({ data: { ...(id ? { id } : {}), ...org(context), accountNumber, statementDate: new Date(statementDate), openingBalance: prior ? prior.closingBalance : 0, closingBalance: round2(closingBalance), startedByUserId: context.userId } });
      await audited(tx, context, 'bank_reconciliation.started', 'bank_reconciliation', r.id);
      return { id: r.id };
    } catch (error) { throw uniqueViolation(error, { open_key: 'RECONCILIATION_IN_PROGRESS' }) ?? error; }
  });
}
async function openRecon(tx, context, id) {
  const [r] = await tx.$queryRaw`SELECT "id" FROM "acct_reconciliations" WHERE "organization_id" = ${context.organizationId} AND "id" = ${id} FOR UPDATE`;
  const recon = r && (await tx.acctReconciliation.findFirst({ where: { ...org(context), id } }));
  if (!recon) throw notFound('Reconciliation');
  if (recon.status !== 'In Progress') throw new EmrError('INVALID_STATE', { message: 'This reconciliation is complete.' });
  return recon;
}
const progressOf = (recon, moves) => {
  const cleared = round2(moves.filter((m) => recon.clearedKeys.includes(m.key)).reduce((n, m) => n + m.amount, 0));
  const clearedTotal = round2(Number(recon.openingBalance) + cleared);
  return { clearedTotal, statementTarget: Number(recon.closingBalance), difference: round2(Number(recon.closingBalance) - clearedTotal) };
};
/** Ticks a ledger movement on or off (each tick is applied under a row lock, so two clerks don't clash). */
export async function toggleCleared(context, id, { movementKey }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const recon = await openRecon(tx, context, id);
    const has = recon.clearedKeys.includes(movementKey);
    if (!has && !(await movements(tx, context, recon.accountNumber, recon.statementDate)).some((m) => m.key === movementKey)) {
      throw new EmrError('VALIDATION_FAILED', { message: 'That is not a posted movement on this account by the statement date.' });
    }
    const clearedKeys = has ? recon.clearedKeys.filter((k) => k !== movementKey) : [...recon.clearedKeys, movementKey];
    await tx.acctReconciliation.updateMany({ where: { ...org(context), id }, data: { clearedKeys, version: { increment: 1 } } });
    return { id, cleared: !has };
  });
}
export async function completeReconciliation(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const recon = await openRecon(tx, context, id);
    const p = progressOf(recon, await movements(tx, context, recon.accountNumber, recon.statementDate));
    if (Math.abs(p.difference) > 0.01) throw new EmrError('INVALID_STATE', { message: `Still ${Math.abs(p.difference).toLocaleString('en-NG')} out — clear or add the missing items.`, details: p });
    await tx.acctReconciliation.updateMany({ where: { ...org(context), id }, data: { status: 'Reconciled', completedByUserId: context.userId, completedAt: new Date(), version: { increment: 1 } } });
    await audited(tx, context, 'bank_reconciliation.completed', 'bank_reconciliation', id);
    return { id, status: 'Reconciled' };
  });
}

// ---- live feeds -------------------------------------------------------------------------------------
/** Live feeds need an open-banking provider (consent, tokens, webhooks); none is configured. */
export function bankFeedUnavailable(context) {
  requireAcct(context, 'acct.post');
  throw new EmrError('BANK_FEED_NOT_CONFIGURED');
}
