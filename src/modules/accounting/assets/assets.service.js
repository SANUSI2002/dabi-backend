// Fixed assets: the register behind the ledger's asset accounts.
//
// Rules enforced here:
//   - an asset sits on a fixed-asset ledger account; buying one outright (not through a bill) posts
//     Dr the asset account, Cr the account it was paid from;
//   - construction in progress collects costs on Assets Under Construction and is capitalised once, into
//     service, onto its asset account;
//   - depreciation runs once per month for every active asset that has not yet been charged for it, never
//     below salvage value, posting Dr Depreciation Expense, Cr Accumulated Depreciation;
//   - a revaluation uplift first reverses earlier impairment (to P&L), the rest to Revaluation Reserve; a
//     writedown first uses up the reserve, the rest is an impairment loss;
//   - disposing derecognises cost and accumulated depreciation and books the gain or loss; an asset is
//     retired without proceeds only once it is carried at nothing;
//   - acct.view reads; acct.post does everything else. Funding and proceeds accounts follow the manual-entry
//     rule (no control accounts).
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { nextSequence } from '../../emr/core/sequence.js';
import { ensureBooks, postEntry, requireAcct, round2 } from '../ledger/ledger.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const audited = (tx, context, action, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType: 'fixed_asset', resourceId, changedFields });
const ACCT = { assetsUnderConstruction: 1580, accumDepreciation: 1590, revaluationReserve: 3300, depreciationExpense: 5500, impairmentLoss: 5520, otherIncome: 4100, miscExpense: 5900 };
const iso = (d) => (d ? d.toISOString() : undefined);
const n = (d) => (d === null || d === undefined ? 0 : Number(d));
const ym = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const nextMonth = (p) => { const [y, m] = p.split('-').map(Number); return ym(new Date(Date.UTC(y, m, 1))); };

// ---- the arithmetic (the same as the screens) -------------------------------------------------------
const plain = (a) => ({
  ...a, cost: n(a.cost), salvageValue: n(a.salvageValue), accumulatedDepreciation: n(a.accumulatedDepreciation), reducingRateAnnual: a.reducingRateAnnual === null ? undefined : n(a.reducingRateAnnual),
  revaluationReserve: n(a.revaluationReserve), impairmentLoss: n(a.impairmentLoss), cwipSpend: n(a.cwipSpend),
});
const nbv = (a) => round2(a.cost - a.accumulatedDepreciation);
function monthlyCharge(a) {
  const floor = a.cost - a.salvageValue;
  if (a.status !== 'Active' || a.accumulatedDepreciation >= floor - 0.01) return 0;
  const charge = a.method === 'Straight Line' ? floor / a.usefulLifeMonths : nbv(a) * ((a.reducingRateAnnual ?? 20) / 100 / 12);
  return round2(Math.min(charge, floor - a.accumulatedDepreciation));
}
function preview(assets, period) {
  const entries = [];
  for (const a of assets) {
    if (a.status !== 'Active' || (a.lastDepreciatedPeriod && a.lastDepreciatedPeriod >= period)) continue;
    const amount = monthlyCharge(a);
    if (amount > 0) entries.push({ assetId: a.id, amount, nbvBefore: nbv(a), nbvAfter: round2(nbv(a) - amount) });
  }
  return { entries, total: round2(entries.reduce((s, e) => s + e.amount, 0)) };
}

async function assetOf(tx, context, id) {
  const a = await tx.acctFixedAsset.findFirst({ where: { ...org(context), id } });
  if (!a) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Asset not found.' });
  return plain(a);
}
async function assetAccount(tx, context, number) {
  const a = await tx.acctAccount.findFirst({ where: { ...org(context), number } });
  if (!a || !a.isActive || a.subtype !== 'fixed_asset' || number === ACCT.assetsUnderConstruction) throw new EmrError('VALIDATION_FAILED', { message: `Account ${number} is not a fixed-asset account.` });
}
async function manualAccount(tx, context, number) {
  const a = await tx.acctAccount.findFirst({ where: { ...org(context), number } });
  if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${number} is not available.` });
  if (!a.allowManualEntry) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is posted only by its subledger.` });
}
const change = (tx, context, a, data, action) => updateVersioned(tx.acctFixedAsset, { organizationId: context.organizationId, id: a.id, expectedVersion: a.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' })
  .then(() => audited(tx, context, action, a.id, Object.keys(data)));
async function newTag(tx, context, prefix) {
  return `${prefix}-${String(await nextSequence(tx, context, `acct-${prefix.toLowerCase()}`)).padStart(4, '0')}`;
}

// ---- reading ----------------------------------------------------------------------------------------
export async function overview(context) {
  requireAcct(context, 'acct.view');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    const [assets, runs, revals] = await Promise.all([
      tx.acctFixedAsset.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.acctDepreciationRun.findMany({ where: org(context), orderBy: { period: 'desc' } }),
      tx.acctAssetRevaluation.findMany({ where: org(context), orderBy: { revaluedOn: 'desc' } }),
    ]);
    const names = await userNameMap(tx, [...runs.map((r) => r.runByUserId), ...revals.map((r) => r.byUserId)]);
    const who = (id) => names.get(id) ?? 'Former member';
    return {
      assets: assets.map((raw) => {
        const a = plain(raw);
        return {
          id: a.id, tag: a.tag, name: a.name, category: a.category, acquisitionDate: iso(a.acquisitionDate), cost: a.cost, assetAccountNumber: a.assetAccountNumber, method: a.method, usefulLifeMonths: a.usefulLifeMonths,
          salvageValue: a.salvageValue, reducingRateAnnual: a.reducingRateAnnual, accumulatedDepreciation: a.accumulatedDepreciation, status: a.status, sourceBillId: a.sourceBillId ?? undefined,
          disposalDate: iso(a.disposalDate), disposalProceeds: a.disposalProceeds === null ? undefined : n(a.disposalProceeds), lastDepreciatedPeriod: a.lastDepreciatedPeriod ?? undefined,
          revaluationReserve: a.revaluationReserve, impairmentLoss: a.impairmentLoss, cwipSpend: a.cwipSpend, createdAt: iso(a.createdAt), version: a.version,
        };
      }),
      runs: runs.map((r) => ({ id: r.id, period: r.period, runDate: iso(r.runAt), entries: r.entries, total: n(r.total), journalEntryId: r.journalEntryId, runBy: who(r.runByUserId) })),
      revaluations: revals.map((r) => ({
        id: r.id, assetId: r.assetId, date: iso(r.revaluedOn), kind: r.kind, carryingBefore: n(r.carryingBefore), carryingAfter: n(r.carryingAfter), delta: n(r.delta), note: r.note ?? undefined, journalEntryId: r.journalEntryId, by: who(r.byUserId),
      })),
    };
  });
}

// ---- registering ------------------------------------------------------------------------------------
export async function addAsset(context, input) {
  requireAcct(context, 'acct.post');
  if (input.salvageValue > input.cost) throw new EmrError('VALIDATION_FAILED', { message: 'Salvage value cannot exceed cost.' });
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    await assetAccount(tx, context, input.assetAccountNumber);
    if (input.sourceBillId) {
      const bill = await tx.acctPurchaseDoc.findFirst({ where: { ...org(context), id: input.sourceBillId, kind: 'bill' } });
      if (!bill || !bill.journalEntryId) throw new EmrError('VALIDATION_FAILED', { message: 'That bill is not posted.' });
    } else if (input.fundedFromAccount) await manualAccount(tx, context, input.fundedFromAccount);
    const tag = await newTag(tx, context, 'FA');
    let a;
    try {
      a = await tx.acctFixedAsset.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), tag, name: input.name, category: input.category, acquisitionDate: new Date(input.acquisitionDate), cost: input.cost, assetAccountNumber: input.assetAccountNumber,
          method: input.method, usefulLifeMonths: input.usefulLifeMonths, salvageValue: input.salvageValue, reducingRateAnnual: input.method === 'Reducing Balance' ? input.reducingRateAnnual ?? 20 : null,
          sourceBillId: input.sourceBillId ?? null, createdByUserId: context.userId,
        },
      });
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE', tag_key: 'HR_CODE_IN_USE' }) ?? error; }
    // Bought outright (not through a bill): capitalise it now.
    if (!input.sourceBillId && input.fundedFromAccount) {
      await postEntry(tx, context, {
        date: input.acquisitionDate, source: 'Manual', memo: `Capitalise ${tag} — ${input.name}`, reference: tag,
        lines: [{ accountNumber: input.assetAccountNumber, debit: input.cost, credit: 0, description: input.name }, { accountNumber: input.fundedFromAccount, debit: 0, credit: input.cost, description: `Acquisition of ${tag}` }],
      });
    }
    await audited(tx, context, 'fixed_asset.registered', a.id);
    return { id: a.id, tag };
  });
}

export async function startConstruction(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    await ensureBooks(tx, context);
    await assetAccount(tx, context, input.assetAccountNumber);
    const tag = await newTag(tx, context, 'CWIP');
    const a = await tx.acctFixedAsset.create({
      data: { ...(input.id ? { id: input.id } : {}), ...org(context), tag, name: input.name, category: input.category, acquisitionDate: new Date(input.startDate), assetAccountNumber: input.assetAccountNumber, status: 'Under Construction', createdByUserId: context.userId },
    });
    await audited(tx, context, 'fixed_asset.construction_started', a.id);
    return { id: a.id, tag };
  });
}
export async function addCwipCost(context, id, { amount, date, description, fromAccount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await assetOf(tx, context, id);
    if (a.status !== 'Under Construction') throw new EmrError('INVALID_STATE', { message: 'Not a construction-in-progress asset.' });
    await manualAccount(tx, context, fromAccount);
    await postEntry(tx, context, {
      date, source: 'Manual', memo: `CWIP cost — ${a.name}: ${description}`, reference: a.tag,
      lines: [{ accountNumber: ACCT.assetsUnderConstruction, debit: round2(amount), credit: 0, description }, { accountNumber: fromAccount, debit: 0, credit: round2(amount), description: `Paid for ${a.name} works` }],
    });
    await change(tx, context, a, { cwipSpend: round2(a.cwipSpend + amount) }, 'fixed_asset.construction_cost');
    return { id };
  });
}
export async function capitaliseCwip(context, id, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await assetOf(tx, context, id);
    if (a.status !== 'Under Construction') throw new EmrError('INVALID_STATE', { message: 'Not a construction-in-progress asset.' });
    const total = round2(a.cwipSpend);
    if (total <= 0) throw new EmrError('INVALID_STATE', { message: 'No costs accumulated yet.' });
    if (input.salvageValue > total) throw new EmrError('VALIDATION_FAILED', { message: 'Salvage value cannot exceed cost.' });
    await postEntry(tx, context, {
      date: input.date, source: 'Manual', memo: `Capitalise ${a.name} — placed in service`, reference: a.tag,
      lines: [{ accountNumber: a.assetAccountNumber, debit: total, credit: 0, description: `${a.name} capitalised` }, { accountNumber: ACCT.assetsUnderConstruction, debit: 0, credit: total, description: `CWIP transferred — ${a.tag}` }],
    });
    await change(tx, context, a, {
      cost: total, status: 'Active', acquisitionDate: new Date(input.date), method: input.method, usefulLifeMonths: input.usefulLifeMonths, salvageValue: input.salvageValue,
      reducingRateAnnual: input.method === 'Reducing Balance' ? input.reducingRateAnnual ?? 20 : null, tag: await newTag(tx, context, 'FA'), // a register number of its own
    }, 'fixed_asset.capitalised');
    return { id };
  });
}

// ---- depreciation -----------------------------------------------------------------------------------
async function runInTx(tx, context, period) {
  if (await tx.acctDepreciationRun.findFirst({ where: { ...org(context), period } })) throw new EmrError('INVALID_STATE', { message: `Depreciation for ${period} has already been run.` });
  const assets = (await tx.acctFixedAsset.findMany({ where: { ...org(context), status: 'Active' } })).map(plain);
  const { entries, total } = preview(assets, period);
  if (!entries.length) throw new EmrError('INVALID_STATE', { message: 'Nothing to depreciate for that period.' });
  const [y, m] = period.split('-').map(Number);
  const date = new Date(Math.min(Date.UTC(y, m, 0, 12), Date.now()));
  const entry = await postEntry(tx, context, {
    date, source: 'Depreciation', memo: `Depreciation — ${period}`, reference: period,
    lines: [{ accountNumber: ACCT.depreciationExpense, debit: total, credit: 0, description: `Depreciation expense — ${period}` }, { accountNumber: ACCT.accumDepreciation, debit: 0, credit: total, description: `Accumulated depreciation — ${period}` }],
  });
  try {
    await tx.acctDepreciationRun.create({ data: { ...org(context), period, entries, total, journalEntryId: entry.id, runByUserId: context.userId } });
  } catch (error) { throw uniqueViolation(error, { period_key: 'INVALID_STATE' }) ?? error; }
  for (const e of entries) {
    const a = assets.find((x) => x.id === e.assetId);
    const accum = round2(a.accumulatedDepreciation + e.amount);
    await updateVersioned(tx.acctFixedAsset, {
      organizationId: context.organizationId, id: a.id, expectedVersion: a.version, notFoundCode: 'HR_RECORD_NOT_FOUND',
      data: { accumulatedDepreciation: accum, lastDepreciatedPeriod: period, ...(accum >= a.cost - a.salvageValue - 0.01 ? { status: 'Fully Depreciated' } : {}) },
    });
  }
  await recordAudit(tx, context, { action: 'depreciation.run', resourceType: 'depreciation_run', resourceId: period, changedFields: [String(total)] });
  return { period, total };
}
export async function runDepreciation(context, { period }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, (tx) => runInTx(tx, context, period));
}
/** Months from the earliest asset (never before the books lock) through `through` that still have a charge. */
async function pendingPeriods(tx, context, through) {
  const assets = (await tx.acctFixedAsset.findMany({ where: { ...org(context), status: { in: ['Active', 'Fully Depreciated'] } } })).map(plain);
  if (!assets.length) return [];
  const settings = await tx.acctLedgerSettings.findUnique({ where: { organizationId: context.organizationId } });
  const lockMonth = settings?.booksLockedBefore ? ym(settings.booksLockedBefore) : '0000-00';
  const done = new Set((await tx.acctDepreciationRun.findMany({ where: org(context), select: { period: true } })).map((r) => r.period));
  const earliest = assets.map((a) => ym(a.acquisitionDate)).sort()[0];
  let cursor = earliest > lockMonth ? earliest : lockMonth;
  const out = [];
  for (let guard = 0; cursor <= through && guard < 240; guard += 1, cursor = nextMonth(cursor)) {
    if (!done.has(cursor) && preview(assets, cursor).entries.length) out.push(cursor);
  }
  return out;
}
/** Runs every month still owed, oldest first, in one transaction (all or nothing). */
export async function catchUp(context, { through }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const ran = [];
    let total = 0;
    for (const p of await pendingPeriods(tx, context, through ?? ym(new Date()))) {
      const r = await runInTx(tx, context, p);
      ran.push(p);
      total = round2(total + r.total);
    }
    return { ran, total };
  });
}

// ---- revaluation, disposal --------------------------------------------------------------------------
export async function revalueAsset(context, id, { newCarryingValue, date, note }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await assetOf(tx, context, id);
    if (a.status === 'Disposed' || a.status === 'Under Construction') throw new EmrError('INVALID_STATE', { message: "Can't revalue this asset." });
    const before = nbv(a); // revaluations already move cost; the reserve and impairment are tallies of them
    const delta = round2(newCarryingValue - before);
    if (Math.abs(delta) < 0.005) throw new EmrError('VALIDATION_FAILED', { message: 'New value matches the current carrying amount.' });
    const lines = [];
    let reserve = a.revaluationReserve;
    let impairment = a.impairmentLoss;
    if (delta > 0) {
      const reversal = Math.min(delta, impairment);
      const toReserve = round2(delta - reversal);
      lines.push({ accountNumber: a.assetAccountNumber, debit: delta, credit: 0, description: `Revaluation uplift — ${a.tag}` });
      if (reversal > 0) lines.push({ accountNumber: ACCT.impairmentLoss, debit: 0, credit: reversal, description: 'Impairment reversal' });
      if (toReserve > 0) lines.push({ accountNumber: ACCT.revaluationReserve, debit: 0, credit: toReserve, description: 'Revaluation surplus' });
      reserve = round2(reserve + toReserve);
      impairment = round2(impairment - reversal);
    } else {
      const amt = -delta;
      const fromReserve = Math.min(amt, reserve);
      const toImpair = round2(amt - fromReserve);
      if (fromReserve > 0) lines.push({ accountNumber: ACCT.revaluationReserve, debit: fromReserve, credit: 0, description: 'Reverse revaluation surplus' });
      if (toImpair > 0) lines.push({ accountNumber: ACCT.impairmentLoss, debit: toImpair, credit: 0, description: `Impairment — ${a.tag}` });
      lines.push({ accountNumber: a.assetAccountNumber, debit: 0, credit: amt, description: `Writedown — ${a.tag}` });
      reserve = round2(reserve - fromReserve);
      impairment = round2(impairment + toImpair);
    }
    const entry = await postEntry(tx, context, { date, source: 'Manual', memo: `${delta > 0 ? 'Revaluation' : 'Impairment'} — ${a.name}`, reference: a.tag, lines });
    const kind = delta > 0 ? (a.impairmentLoss > 0 ? 'Reversal' : 'Revaluation') : 'Impairment';
    await tx.acctAssetRevaluation.create({ data: { ...org(context), assetId: id, revaluedOn: new Date(date), kind, carryingBefore: before, carryingAfter: round2(newCarryingValue), delta, note: note ?? null, journalEntryId: entry.id, byUserId: context.userId } });
    const status = impairment > 0 && delta < 0 ? 'Impaired' : a.status === 'Impaired' && delta > 0 ? 'Active' : a.status;
    await change(tx, context, a, { cost: round2(a.cost + delta), revaluationReserve: Math.max(0, reserve), impairmentLoss: Math.max(0, impairment), status }, `fixed_asset.${kind.toLowerCase()}`);
    return { id, kind, delta };
  });
}
export async function disposeAsset(context, id, { date, proceeds, proceedsAccount }) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await assetOf(tx, context, id);
    if (a.status === 'Disposed') throw new EmrError('INVALID_STATE', { message: 'Already disposed.' });
    if (a.status === 'Under Construction') throw new EmrError('INVALID_STATE', { message: 'Capitalise construction in progress before disposing of it.' });
    const gain = round2(proceeds - nbv(a));
    const lines = [
      ...(proceeds > 0 ? [{ accountNumber: proceedsAccount, debit: proceeds, credit: 0, description: `Proceeds — ${a.tag}` }] : []),
      ...(a.accumulatedDepreciation > 0 ? [{ accountNumber: ACCT.accumDepreciation, debit: a.accumulatedDepreciation, credit: 0, description: `Clear accum. depreciation — ${a.tag}` }] : []),
      { accountNumber: a.assetAccountNumber, debit: 0, credit: a.cost, description: `Derecognise cost — ${a.tag}` },
    ];
    if (gain > 0.01) lines.push({ accountNumber: ACCT.otherIncome, debit: 0, credit: gain, description: `Gain on disposal — ${a.tag}` });
    else if (gain < -0.01) lines.push({ accountNumber: ACCT.miscExpense, debit: -gain, credit: 0, description: `Loss on disposal — ${a.tag}` });
    if (proceeds > 0) await manualAccount(tx, context, proceedsAccount);
    if (a.cost > 0) await postEntry(tx, context, { date, source: 'Manual', memo: `Disposal of ${a.tag} — ${a.name}`, reference: a.tag, lines });
    await change(tx, context, a, { status: 'Disposed', disposalDate: new Date(date), disposalProceeds: proceeds }, 'fixed_asset.disposed');
    return { id, gainLoss: gain };
  });
}
/** Takes a fully written-down asset off the register (its cost and depreciation are cleared). */
export async function retireAsset(context, id) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    const a = await assetOf(tx, context, id);
    if (a.status === 'Disposed') throw new EmrError('INVALID_STATE', { message: 'Already disposed.' });
    if (nbv(a) > 0.01) throw new EmrError('INVALID_STATE', { message: `This asset is still carried at ${nbv(a).toLocaleString('en-NG')}. Dispose of it instead, with any proceeds.` });
    if (a.cost > 0) {
      await postEntry(tx, context, {
        date: new Date(), source: 'Manual', memo: `Retire ${a.tag} — ${a.name}`, reference: a.tag,
        lines: [
          { accountNumber: ACCT.accumDepreciation, debit: a.accumulatedDepreciation, credit: 0, description: `Clear accum. depreciation — ${a.tag}` },
          ...(nbv(a) > 0 ? [{ accountNumber: ACCT.miscExpense, debit: nbv(a), credit: 0, description: `Write-off — ${a.tag}` }] : []),
          { accountNumber: a.assetAccountNumber, debit: 0, credit: a.cost, description: `Derecognise cost — ${a.tag}` },
        ],
      });
    }
    await change(tx, context, a, { status: 'Disposed', disposalDate: new Date(), disposalProceeds: 0 }, 'fixed_asset.retired');
    return { id };
  });
}
