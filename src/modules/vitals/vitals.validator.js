import { z } from 'zod';

export const VITAL_UNITS = Object.freeze({
  BLOOD_PRESSURE: ['mmHg'], HEART_RATE: ['bpm'], TEMPERATURE: ['C', 'F'],
  BLOOD_GLUCOSE: ['mg/dL', 'mmol/L'], OXYGEN_SATURATION: ['%'],
});
export const VITAL_TYPES = Object.keys(VITAL_UNITS);
const vitalType = z.enum(VITAL_TYPES);
const isoDateTime = z.string().datetime({ offset: true });
const pageQuery = { page: z.coerce.number().int().min(1).max(10000).default(1), limit: z.coerce.number().int().min(1).max(100).default(20) };
const numericValue = z.union([z.number().finite(), z.string().trim().regex(/^\d{1,3}(?:\.\d{1,2})?$/)]).transform(String);
const bloodPressure = z.string().trim().regex(/^\d{2,3}\/\d{2,3}$/);

const validScalar = (value, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max;
};
const validateVital = ({ type, unit, value }, ctx) => {
  if (!VITAL_UNITS[type].includes(unit)) ctx.addIssue({ code: 'custom', path: ['unit'], message: 'Unit is not supported for this vital type' });
  if (type === 'BLOOD_PRESSURE') {
    if (!/^\d{2,3}\/\d{2,3}$/.test(value)) return ctx.addIssue({ code: 'custom', path: ['value'], message: 'Blood pressure must be systolic/diastolic' });
    const [systolic, diastolic] = value.split('/').map(Number);
    if (systolic < 70 || systolic > 250 || diastolic < 40 || diastolic > 160 || systolic <= diastolic) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Blood pressure is outside supported recording bounds' });
    return;
  }
  const ranges = { HEART_RATE: [20, 250], TEMPERATURE: unit === 'C' ? [30, 45] : [86, 113], BLOOD_GLUCOSE: unit === 'mg/dL' ? [20, 600] : [1, 35], OXYGEN_SATURATION: [50, 100] };
  if (!validScalar(value, ...ranges[type])) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Value is outside supported recording bounds' });
};

export const listVitalsSchema = z.object({
  query: z.object({ ...pageQuery, type: vitalType.optional(), status: z.enum(['NORMAL', 'LOW', 'HIGH', 'UNSPECIFIED']).optional(), from: isoDateTime.optional(), to: isoDateTime.optional(), sort: z.enum(['asc', 'desc']).default('desc') }).strict(),
}).superRefine(({ query }, ctx) => { if (query.from && query.to && new Date(query.from) > new Date(query.to)) ctx.addIssue({ code: 'custom', path: ['query', 'to'], message: 'to must be after from' }); });
export const createVitalSchema = z.object({
  body: z.object({ type: vitalType, unit: z.string().trim().min(1).max(10), value: z.union([numericValue, bloodPressure]), status: z.enum(['NORMAL', 'LOW', 'HIGH', 'UNSPECIFIED']).default('UNSPECIFIED'), recordedAt: isoDateTime }).strict(),
}).superRefine(({ body }, ctx) => validateVital(body, ctx));
