// Append-only EMR audit trail, written in the same transaction as the change it records.
// Only field *names* are stored for updates — values stay in the clinical tables.
export async function recordAudit(tx, context, { action, resourceType, resourceId = null, changedFields = [] }) {
  await tx.emrAuditEvent.create({
    data: {
      organizationId: context.organizationId,
      actorUserId: context.userId ?? null,
      action,
      resourceType,
      resourceId,
      requestId: context.requestId ?? null,
      changedFields,
    },
  });
}

// Field names whose values differ between `before` and the submitted `changes`.
export const changedFieldNames = (before, changes) =>
  Object.keys(changes).filter((key) => changes[key] !== undefined && JSON.stringify(before[key] ?? null) !== JSON.stringify(changes[key] ?? null));

export async function listAudit(tx, { resourceType, resourceId, cursor, limit = 50 }) {
  const rows = await tx.emrAuditEvent.findMany({
    where: { ...(resourceType ? { resourceType } : {}), ...(resourceId ? { resourceId } : {}) },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    take: limit + 1,
  });
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
