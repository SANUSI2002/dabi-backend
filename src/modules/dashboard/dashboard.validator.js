import { z } from 'zod';

export const recordsStatsResponseSchema = z.object({
  total_records: z.number().int().nonnegative(),
  total_hospital_visits: z.number().int().nonnegative(),
  total_consultations: z.number().int().nonnegative(),
});
