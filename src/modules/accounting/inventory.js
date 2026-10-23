// Inventory accounting reads the hospital's own stores (GET /inventory): items, batches and movements as
// the Stores module keeps them, each item with the ledger accounts it posts to. Finance sees the valuation
// with acct.view; stock is issued, adjusted and counted in Stores, and the Stores connector posts those
// movements to the books.
//
// A receipt recorded here (POST /inventory/receipts) is stock paid for outside a bill: the batch goes into
// the store and, in the same transaction, Dr the item's inventory account, Cr the account it was paid
// from. Without a paying account the receipt waits for its bill, like any other stores receipt.
//
// A landed cost (POST /inventory/landed-costs) adds freight, duty or clearing to stock already received;
// see applyLandedCost below.
import { withTenant } from '../emr/core/db.js';
import { EmrError } from '../emr/core/errors.js';
import { lockItem, mainLocationId, overview as storesOverview, receiveInTx } from '../emr/stores/stores.service.js';
import { recordAudit } from '../emr/core/audit.js';
import { postEntry, requireAcct, round2 } from './ledger/ledger.service.js';
import { storeAccountsFor } from './integrations/integrations.service.js';

export async function inventoryOverview(context) {
  requireAcct(context, 'acct.view');
  const data = await storesOverview(context, { movementLimit: 500 });
  const landedCosts = await withTenant(context, (tx) => tx.acctLandedCost.findMany({ where: { organizationId: context.organizationId }, orderBy: { costDate: 'desc' }, take: 200 }));
  return {
    ...data, accounts: Object.fromEntries(data.items.map((i) => [i.id, storeAccountsFor(i.category)])),
    landedCosts: landedCosts.map((l) => ({ id: l.id, date: l.costDate.toISOString(), description: l.description, creditAccount: l.creditAccount, total: Number(l.total), allocations: l.allocations, journalEntryId: l.journalEntryId })),
  };
}

export async function receiveStock(context, input) {
  requireAcct(context, 'acct.post');
  return withTenant(context, async (tx) => {
    if (input.fundingAccount) {
      const a = await tx.acctAccount.findFirst({ where: { organizationId: context.organizationId, number: input.fundingAccount } });
      if (!a || !a.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${input.fundingAccount} is not available.` });
      if (!a.allowManualEntry) throw new EmrError('INVALID_STATE', { message: `Account ${a.number} ${a.name} is posted only by its subledger. Record the purchase as a bill instead.` });
    }
    const locationId = input.locationId ?? (await mainLocationId(tx, context));
    const { item, batch } = await receiveInTx(tx, context, { ...input, locationId });
    const value = round2((input.qty * input.unitCostMinor) / 100);
    if (input.fundingAccount && value > 0) {
      const acct = storeAccountsFor(item.category);
      const entry = await postEntry(tx, context, {
        date: new Date(), source: 'Inventory', memo: `Stock received — ${item.name}`, reference: (input.reference ?? batch.batchNumber ?? 'Receipt').slice(0, 100),
        lines: [{ accountNumber: acct.inventory, debit: value, credit: 0, description: `${input.qty} ${item.unit}` }, { accountNumber: input.fundingAccount, debit: 0, credit: value, description: `Paid for ${item.name}` }],
      });
      // this receipt is in the books now: the Stores connector leaves it alone
      const move = await tx.emrStoreMovement.findFirst({ where: { organizationId: context.organizationId, batchId: batch.id, kind: 'RECEIPT' }, select: { id: true } });
      await tx.acctIntegrationEvent.create({ data: { organizationId: context.organizationId, kind: 'store-movement', sourceRef: move.id, data: { posted: true, kind: 'RECEIPT', funded: true }, journalEntryId: entry.id } });
    }
    return { batchId: batch.id, value };
  });
}

// ---- landed costs -----------------------------------------------------------------------------------
// Freight, duty, clearing and the like, added after the stock was received. Each item's share raises
// the unit cost of its batches still on hand by the same amount per unit, so the stores valuation and the
// inventory account move together; what falls on stock already used (none left on hand), and the odd kobo
// a per-unit split cannot carry, goes to the item's cost of goods sold. Cr the account it was paid from or
// is owed on (one only its subledger posts, such as accounts payable, is refused: record a bill instead).
const toMinor = (naira) => BigInt(Math.round(naira * 100));
const toNaira = (minor) => Number(minor) / 100;

export async function applyLandedCost(context, input) {
  requireAcct(context, 'acct.post');
  const allocations = input.allocations.filter((a) => a.amount > 0);
  if (!allocations.length) throw new EmrError('VALIDATION_FAILED', { message: 'Enter at least one cost allocation.' });
  if (new Set(allocations.map((a) => a.itemId)).size !== allocations.length) throw new EmrError('VALIDATION_FAILED', { message: 'Allocate to each item once.' });
  return withTenant(context, async (tx) => {
    const credit = await tx.acctAccount.findFirst({ where: { organizationId: context.organizationId, number: input.creditAccount } });
    if (!credit || !credit.isActive) throw new EmrError('ACCOUNT_NOT_FOUND', { message: `Account ${input.creditAccount} is not available.` });
    if (!credit.allowManualEntry) throw new EmrError('INVALID_STATE', { message: `Account ${credit.number} ${credit.name} is posted only by its subledger. Record the charge as a bill instead.` });
    const shares = [];
    const lines = [];
    // items in a fixed order, each locked as a stock movement would lock it
    for (const a of [...allocations].sort((x, y) => x.itemId.localeCompare(y.itemId))) {
      await lockItem(tx, context, a.itemId);
      const item = await tx.emrStoreItem.findFirst({ where: { organizationId: context.organizationId, id: a.itemId } });
      if (!item) throw new EmrError('STORE_ITEM_NOT_FOUND');
      const batches = await tx.emrStoreBatch.findMany({ where: { organizationId: context.organizationId, itemId: item.id, qtyRemaining: { gt: 0 } }, orderBy: { id: 'asc' } });
      const onHand = batches.reduce((n, b) => n + b.qtyRemaining, 0);
      const amountMinor = toMinor(a.amount);
      const perUnit = onHand ? amountMinor / BigInt(onHand) : 0n;
      const capitalised = perUnit * BigInt(onHand);
      const expensed = amountMinor - capitalised;
      for (const b of perUnit > 0n ? batches : []) {
        await tx.$executeRaw`SELECT emr_raise_batch_cost(${b.id}, ${perUnit})`; // the only way a batch cost changes
      }
      const acct = storeAccountsFor(item.category);
      const name = item.name.slice(0, 120);
      if (capitalised > 0n) lines.push({ accountNumber: acct.inventory, debit: toNaira(capitalised), credit: 0, description: `Landed cost — ${name} (${onHand} on hand)` });
      if (expensed > 0n) lines.push({ accountNumber: acct.cogs, debit: toNaira(expensed), credit: 0, description: `Landed cost on stock already used — ${name}` });
      shares.push({ itemId: item.id, itemName: item.name, amount: toNaira(amountMinor), onHand, perUnit: toNaira(perUnit), capitalised: toNaira(capitalised), expensed: toNaira(expensed), batchIds: perUnit > 0n ? batches.map((b) => b.id) : [] });
    }
    const total = round2(shares.reduce((n, s) => n + s.amount, 0));
    lines.push({ accountNumber: credit.number, debit: 0, credit: total, description: input.description.slice(0, 300) });
    const entry = await postEntry(tx, context, { date: new Date(input.date), source: 'Inventory', memo: `Landed costs — ${input.description}`.slice(0, 500), reference: (input.reference ?? 'Landed cost').slice(0, 100), lines });
    const row = await tx.acctLandedCost.create({
      data: {
        ...(input.id ? { id: input.id } : {}), organizationId: context.organizationId, costDate: new Date(input.date), description: input.description, creditAccount: credit.number,
        total, allocations: shares, journalEntryId: entry.id, createdByUserId: context.userId,
      },
    });
    await recordAudit(tx, context, { action: 'inventory.landed_cost', resourceType: 'landed_cost', resourceId: row.id, changedFields: shares.map((s) => s.itemId) });
    return { id: row.id, journalEntryId: entry.id, total, allocations: shares };
  });
}
