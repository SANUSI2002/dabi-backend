const fail = (code) => Object.assign(new Error(code), { code });
export const verifiedOwner = async (tx, userId) => { const role = await tx.userRole.findFirst({ where: { userId, role: 'PHARMACY_ADMIN' }, select: { id: true } }); const pharmacy = role && await tx.pharmacy.findFirst({ where: { adminUserId: userId, complianceStatus: 'VERIFIED' }, select: { id: true } }); if (!pharmacy) throw fail('NOT_FOUND'); return pharmacy; };
export const error = fail;
