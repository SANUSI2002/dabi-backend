export const fail = (code) => Object.assign(new Error(code), { code });
export const requireRole = async (tx, userId, role) => {
  if (!await tx.userRole.findFirst({ where: { userId, role }, select: { id: true } })) throw fail('NOT_FOUND');
};
export const transitions = { approve: { from: ['PENDING', 'REJECTED'], to: 'VERIFIED' }, reject: { from: ['PENDING'], to: 'REJECTED' }, suspend: { from: ['VERIFIED'], to: 'SUSPENDED' }, reactivate: { from: ['SUSPENDED'], to: 'VERIFIED' } };
