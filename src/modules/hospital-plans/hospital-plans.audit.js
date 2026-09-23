export const record = (tx, userId, type, hospitalId, planId) => tx.activityLog.create({ data: { userId, type, description: 'Hospital member plan catalogue changed', meta: { hospitalId, planId } } });
