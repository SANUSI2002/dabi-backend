export const audit = (tx, userId, type, inventoryItemId) => tx.activityLog.create({ data: { userId, type, description: 'Pharmacy inventory changed', meta: { inventoryItemId } } });
