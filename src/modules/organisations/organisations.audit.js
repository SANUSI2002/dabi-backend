export const record = (tx, userId, type, organisationId) => tx.activityLog.create({ data: { userId, type, description: 'Organisation onboarding state changed', meta: { organisationId } } });
