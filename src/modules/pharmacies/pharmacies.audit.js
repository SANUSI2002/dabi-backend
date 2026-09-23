export const audit = (tx, userId, type, pharmacyId) => tx.activityLog.create({ data: { userId, type, description: 'Pharmacy compliance state changed', meta: { pharmacyId } } });
