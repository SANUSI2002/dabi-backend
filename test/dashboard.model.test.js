import { beforeEach, describe, expect, it, vi } from 'vitest';

const fn = () => vi.fn();
const prisma = {
  user: { findUnique: fn() }, userProfile: { findUnique: fn() },
  appointment: { findFirst: fn(), count: fn() }, vital: { findFirst: fn() },
  medicalRecord: { findMany: fn(), count: fn() }, medication: { findMany: fn(), count: fn() },
  familyMember: { findMany: fn() }, healthMetric: { findFirst: fn(), findMany: fn() },
  notification: { count: fn() },
};
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { getDashboardOverview, getRecordsStats } = await import('../src/modules/dashboard/dashboard.model.js');
const userId = '5f95ea6b-15e7-4b29-85be-8189931bf2d6';

beforeEach(() => {
  vi.clearAllMocks();
  Object.values(prisma).flatMap(Object.values).forEach((mock) => mock.mockResolvedValue(null));
  prisma.medicalRecord.findMany.mockResolvedValue([]);
  prisma.medication.findMany.mockResolvedValue([]);
  prisma.medication.count.mockResolvedValue(0);
  prisma.familyMember.findMany.mockResolvedValue([]);
  prisma.healthMetric.findMany.mockResolvedValue([]);
  prisma.notification.count.mockResolvedValue(0);
  prisma.medicalRecord.count.mockResolvedValue(0);
  prisma.appointment.count.mockResolvedValue(0);
});

describe('dashboard overview data access', () => {
  it('returns a stable, scoped empty dashboard and starts widget reads concurrently', async () => {
    const result = await getDashboardOverview(userId, new Date('2026-09-11T12:00:00.000Z'));
    expect(result).toMatchObject({
      user: { full_name: null, patientId: null }, health_score: { score: 0, weekly_trend: 'No change this week', max: 100 },
      health_metrics: [], notifications: { unread_count: 0 }, today_schedule: null,
      vital_history: { blood_pressure: null, heart_rate: null }, recent_consultations: [],
      medications: { remaining_count: 0, items: [] }, family_health: [],
    });
    for (const mock of [prisma.user.findUnique, prisma.userProfile.findUnique, prisma.appointment.findFirst,
      prisma.vital.findFirst, prisma.medicalRecord.findMany, prisma.medication.count, prisma.medication.findMany,
      prisma.familyMember.findMany, prisma.healthMetric.findFirst, prisma.healthMetric.findMany, prisma.notification.count]) {
      expect(mock).toHaveBeenCalled();
    }
  });

  it('uses only persisted profile score, stable ordering/limits, and user scope on every query', async () => {
    prisma.userProfile.findUnique.mockResolvedValue({ health_score: 72, blood_type: 'O+', chronic_conditions: 'Asthma' });
    prisma.healthMetric.findFirst.mockResolvedValue({ health_score: 90 });
    prisma.healthMetric.findMany.mockResolvedValue([{ id: 'metric-1', health_score: 70, recordedAt: new Date() }]);
    prisma.medication.count.mockResolvedValue(8);
    prisma.medication.findMany.mockResolvedValue([{ id: 'med-1', name: 'A', isTaken: false }]);
    const result = await getDashboardOverview(userId);
    expect(result.health_score.score).toBe(72);
    expect(result.health_score.weekly_trend).toBe('-18 pts this week');
    expect(result.medications.remaining_count).toBe(8);
    expect(prisma.medicalRecord.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId }, orderBy: { date: 'desc' }, take: 5 }));
    expect(prisma.medication.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId, isTaken: false }, orderBy: { time: 'asc' }, take: 5 }));
    expect(prisma.healthMetric.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId }, orderBy: { recordedAt: 'desc' }, take: 7 }));
    expect(prisma.notification.count).toHaveBeenCalledWith({ where: { userId, isRead: false } });
  });

  it('calculates records statistics with independently user-scoped counters', async () => {
    prisma.medicalRecord.count.mockResolvedValueOnce(2).mockResolvedValueOnce(4);
    prisma.appointment.count.mockResolvedValueOnce(3).mockResolvedValueOnce(5);
    expect(await getRecordsStats(userId)).toEqual({ total_records: 2, total_hospital_visits: 7, total_consultations: 5 });
    expect(prisma.medicalRecord.count).toHaveBeenNthCalledWith(1, { where: { userId } });
    expect(prisma.appointment.count).toHaveBeenNthCalledWith(2, { where: { userId } });
  });
});
