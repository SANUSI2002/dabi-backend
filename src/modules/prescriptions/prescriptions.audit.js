export const audit = (tx, userId, type, prescriptionId) => tx.activityLog.create({ data: { userId, type, description: 'Prescription state changed', meta: { prescriptionId } } });
