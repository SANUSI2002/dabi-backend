// Inventory accounting reads the hospital's own stores (GET /inventory): items, batches and movements as
// the Stores module keeps them, each item with the ledger accounts it posts to. Finance sees the valuation
// with acct.view; stock is issued, adjusted and counted in Stores, and the Stores connector posts those
// movements to the books.
//
// A receipt recorded here (POST /inventory/receipts) is stock paid for outside a bill: the batch goes into
// the store and, in the same transaction, Dr the item's inventory account, Cr the account it was paid
// from. Without a paying account the receipt waits for its bill, like any other stores receipt.
import { withTenant } from '../emr/core/db.js';
import { EmrError } from '../emr/core/errors.js';
import { mainLocationId, overview as storesOverview, receiveInTx } from '../emr/stores/stores.service.js';
import { postEntry, requireAcct, round2 } from './ledger/ledger.service.js';
import { storeAccountsFor } from './integrations/integrations.service.js';

export async function inventoryOverview(context) {
  requireAcct(context, 'acct.view');
  const data = await storesOverview(context, { movementLimit: 500 });
  return { ...data, accounts: Object.fromEntries(data.items.map((i) => [i.id, storeAccountsFor(i.category)])) };
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
