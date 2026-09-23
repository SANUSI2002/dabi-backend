import prisma from '../../config/db.js';

// Whitelisted User columns to return alongside a profile. Deliberately excludes
// `password` so the hash is never serialized back to the client.
const safeUserFields = {
  id: true,
  patientId: true,
  email: true,
  full_name: true,
  phone_number: true,
  dob: true,
};

export const getProfileByUserId = async (userId) => {
  return prisma.userProfile.findUnique({
    where: { userId },
    include: { user: { select: safeUserFields } },
  });
};

// Saves the settings-hub payload. Personal-info fields live on the User row while
// everything else lives on UserProfile, so the payload is split and both are
// written inside a single transaction. Only keys that were actually sent are
// applied, so a partial update never clobbers an existing value with undefined.
export const upsertUserProfile = async (userId, payload) => {
  const { full_name, phone_number, email, dob, ...profileData } = payload;

  const userData = {};
  if (full_name !== undefined) userData.full_name = full_name;
  if (phone_number !== undefined) userData.phone_number = phone_number;
  if (email !== undefined) userData.email = email;
  if (dob !== undefined) userData.dob = dob ? new Date(dob) : null;

  if (profileData.data_sharing_consent !== undefined) profileData.dataSharingConsentAt = new Date();
  if (profileData.electronic_health_records !== undefined) profileData.electronicHealthRecordsAt = new Date();
  return prisma.$transaction(async (tx) => {
    if (Object.keys(userData).length > 0) {
      await tx.user.update({ where: { id: userId }, data: userData });
    }

    return tx.userProfile.upsert({
      where: { userId },
      update: profileData,
      create: { userId, ...profileData },
      include: { user: { select: safeUserFields } },
    });
  });
};

export const getEmergencySummary = (userId) => prisma.userProfile.findUnique({
  where: { userId },
  select: { blood_type: true, chronic_conditions: true, known_allergies: true, emergencyContactName: true, emergencyContactPhone: true, emergencyContactRelation: true, emergency_access_permissions: true },
});

// Fetch the hash only for credential verification; controllers must never
// serialize this object into an HTTP response.
export const getUserPasswordById = async (userId) => {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { password: true },
  });
};

export const updateUserPassword = async (userId, password) => {
  return prisma.user.update({
    where: { id: userId },
    data: { password },
    select: { id: true },
  });
};

// Permanently deletes the user and everything belonging to them. The children are
// removed before the parent inside one transaction, so the operation is atomic and
// does not rely on the database's ON DELETE CASCADE being in place.
export const deleteUserAccount = async (userId) => {
  return prisma.$transaction([
    prisma.appointment.deleteMany({ where: { userId } }),
    prisma.medication.deleteMany({ where: { userId } }),
    prisma.vital.deleteMany({ where: { userId } }),
    prisma.medicalRecord.deleteMany({ where: { userId } }),
    prisma.category.deleteMany({ where: { userId } }),
    prisma.familyMember.deleteMany({ where: { userId } }),
    prisma.healthMetric.deleteMany({ where: { userId } }),
    prisma.activityLog.deleteMany({ where: { userId } }),
    prisma.notification.deleteMany({ where: { userId } }),
    prisma.userProfile.deleteMany({ where: { userId } }),
    prisma.user.delete({ where: { id: userId } }),
  ]);
};
