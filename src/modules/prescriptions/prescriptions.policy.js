const fail = (code) => Object.assign(new Error(code), { code });

export const verifiedDoctor = async (tx, userId) => {
  const doctor = await tx.professionalProfile.findFirst({ where: { userId, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' }, select: { id: true } });
  if (!doctor) throw fail('NOT_FOUND');
  return doctor;
};

export const activeCareRelationship = async (tx, patientId, doctorProfileId) => {
  const relationship = await tx.doctorCareRelationship.findFirst({ where: { patientId, doctorProfileId, status: 'ACTIVE', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: { id: true } });
  if (!relationship) throw fail('NOT_FOUND');
};

export const error = fail;
