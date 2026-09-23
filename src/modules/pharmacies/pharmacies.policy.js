const fail = (code) => Object.assign(new Error(code), { code });
export const complianceAdmin = async (tx, userId) => { const role = await tx.userRole.findFirst({ where: { userId, role: 'PHARMACY_COMPLIANCE_ADMIN' }, select: { id: true } }); if (!role) throw fail('NOT_FOUND'); };
export const pharmacyAdmin = async (tx, userId) => { const role = await tx.userRole.findFirst({ where: { userId, role: 'PHARMACY_ADMIN' }, select: { id: true } }); if (!role) throw fail('NOT_FOUND'); };
export const error = fail;
