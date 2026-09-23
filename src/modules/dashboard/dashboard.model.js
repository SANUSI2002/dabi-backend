import prisma from '../../config/db.js';

// --- READ OPERATIONS (Dashboard Overview) ---

// Vital `type` labels can arrive from the frontend or an IoT sync in either the
// spelled-out form or the short code, so we match any of them case-insensitively.
const BLOOD_PRESSURE_LABELS = ['Blood Pressure', 'BP'];
const HEART_RATE_LABELS = ['Heart Rate', 'HR'];

// Builds a Prisma `where` fragment that matches a vital whose `type` equals any
// of the given labels, case-insensitively (e.g. "bp", "BP", "Blood Pressure").
const vitalTypeFilter = (labels) => ({
  OR: labels.map((label) => ({ type: { equals: label, mode: 'insensitive' } })),
});

// The score is a cached, persisted profile value. Metrics only provide a
// display trend; this endpoint never infers a score or clinical conclusion.
const buildHealthScore = (profile, baselineMetric) => {
  const score = profile?.health_score ?? 0;
  const baseline = baselineMetric?.health_score;

  let weekly_trend = 'No change this week';
  if (baseline !== undefined && baseline !== null) {
    const delta = score - baseline;
    if (delta > 0) weekly_trend = `+${delta} pts this week`;
    else if (delta < 0) weekly_trend = `${delta} pts this week`;
  }

  return { score, weekly_trend, max: 100 };
};

// Derives up-to-2-letter initials from a full name, e.g. "John Doe" -> "JD".
const toInitials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');

export const getDashboardOverview = async (userId) => {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Every widget is fetched concurrently to keep the overview endpoint fast.
  const [
    user,
    profile,
    nextAppointment,
    latestBloodPressure,
    latestHeartRate,
    recentConsultations,
    remainingMedicationCount,
    remainingMedications,
    family,
    baselineMetric,
    metricHistory,
    unreadNotifications,
  ] = await Promise.all([
    // User details -> name + the new patientId.
    prisma.user.findUnique({ where: { id: userId }, select: { full_name: true, patientId: true } }),
    prisma.userProfile.findUnique({ where: { userId }, select: { health_score: true, blood_type: true, chronic_conditions: true } }),
    // Today's Schedule -> the single next upcoming appointment.
    prisma.appointment.findFirst({ where: { userId, time: { gte: now } }, orderBy: { time: 'asc' }, select: { id: true, title: true, doctorName: true, time: true, type: true } }),
    // Vital History -> latest Blood Pressure and latest Heart Rate readings.
    // Type labels are matched case-insensitively and accept the short codes
    // ("BP" / "HR") as well as the spelled-out names.
    prisma.vital.findFirst({ where: { userId, ...vitalTypeFilter(BLOOD_PRESSURE_LABELS) }, orderBy: { recordedAt: 'desc' }, select: { id: true, type: true, value: true, unit: true, status: true, recordedAt: true } }),
    prisma.vital.findFirst({ where: { userId, ...vitalTypeFilter(HEART_RATE_LABELS) }, orderBy: { recordedAt: 'desc' }, select: { id: true, type: true, value: true, unit: true, status: true, recordedAt: true } }),
    // Recent Consultations -> top 5 medical records.
    prisma.medicalRecord.findMany({ where: { userId }, orderBy: { date: 'desc' }, take: 5, select: { id: true, title: true, recordType: true, doctorName: true, facility: true, date: true } }),
    // Medications remaining for the day (not yet taken).
    prisma.medication.count({ where: { userId, isTaken: false } }),
    prisma.medication.findMany({ where: { userId, isTaken: false }, orderBy: { time: 'asc' }, take: 5, select: { id: true, name: true, instructions: true, time: true, isTaken: true } }),
    // Family Health -> linked dependents (initials derived below).
    prisma.familyMember.findMany({ where: { userId }, orderBy: { name: 'asc' }, take: 5, select: { id: true, name: true, relation: true } }),
    prisma.healthMetric.findFirst({ where: { userId, recordedAt: { lte: sevenDaysAgo } }, orderBy: { recordedAt: 'desc' } }),
    prisma.healthMetric.findMany({ where: { userId }, orderBy: { recordedAt: 'desc' }, take: 7, select: { id: true, health_score: true, recordedAt: true } }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return {
    user: {
      full_name: user?.full_name ?? null,
      patientId: user?.patientId ?? null,
    },
    health_score: buildHealthScore(profile, baselineMetric),
    health_metrics: metricHistory,
    notifications: { unread_count: unreadNotifications },
    emergency_id: {
      blood_type: profile?.blood_type || 'N/A',
      critical_info: profile?.chronic_conditions ? 'Available' : 'None',
    },
    today_schedule: nextAppointment, // next upcoming appointment, or null
    vital_history: {
      blood_pressure: latestBloodPressure,
      heart_rate: latestHeartRate,
    },
    recent_consultations: recentConsultations,
    medications: {
      remaining_count: remainingMedicationCount,
      items: remainingMedications,
    },
    family_health: family.map((member) => ({
      id: member.id,
      name: member.name,
      relation: member.relation,
      initials: toInitials(member.name),
    })),
  };
};

// --- MEDICAL RECORDS STATS (top cards on the Medical Records screen) ---
// total_records         -> every medical record row for the user.
// total_hospital_visits -> in-person appointments PLUS medical records that name
//                          a facility, combined (a "visit" can originate from
//                          either data source, and there is no link between them).
// total_consultations   -> every appointment (each represents a doctor consultation).
export const getRecordsStats = async (userId) => {
  const [totalRecords, inPersonVisits, recordsWithFacility, totalConsultations] = await Promise.all([
    prisma.medicalRecord.count({ where: { userId } }),
    prisma.appointment.count({ where: { userId, OR: [{ type: { equals: 'In-Person', mode: 'insensitive' } }, { type: 'IN_PERSON' }] } }),
    // `facility` is a required column, so "has a facility" means a non-empty value.
    prisma.medicalRecord.count({ where: { userId, facility: { not: '' } } }),
    prisma.appointment.count({ where: { userId } }),
  ]);

  return {
    total_records: totalRecords,
    total_hospital_visits: inPersonVisits + recordsWithFacility,
    total_consultations: totalConsultations,
  };
};
