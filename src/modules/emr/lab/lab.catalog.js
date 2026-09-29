// Laboratory test definitions: the analyte shape (validated whenever a tenant edits its catalog)
// and the starter catalog every organization receives on first use.
//
// Reference ranges are typical adult values in SI units, for a starting point only — each lab
// must review and adjust them to its own analysers and population before clinical use.
import { z } from 'zod';

const range = z.object({ low: z.number().finite().optional(), high: z.number().finite().optional() }).strict();

export const analyteSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,23}$/, 'Analyte codes are upper-case letters, digits and _'),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['NUMERIC', 'CHOICE', 'TEXT']),
  unit: z.string().trim().max(20).optional(),
  low: z.number().finite().optional(),
  high: z.number().finite().optional(),
  criticalLow: z.number().finite().optional(),
  criticalHigh: z.number().finite().optional(),
  female: range.optional(),
  male: range.optional(),
  options: z.array(z.string().trim().min(1).max(40)).min(2).max(20).optional(),
  normal: z.array(z.string().trim().min(1).max(40)).min(1).max(20).optional(),
}).strict().superRefine((a, ctx) => {
  const issue = (message) => ctx.addIssue({ code: 'custom', message: `${a.code}: ${message}` });
  if (a.kind === 'CHOICE' && !a.options) issue('choice analytes need options');
  if (a.kind !== 'CHOICE' && (a.options || a.normal)) issue('only choice analytes take options');
  if (a.normal && a.options && a.normal.some((n) => !a.options.includes(n))) issue('normal values must be among the options');
  if (a.kind !== 'NUMERIC' && ['low', 'high', 'criticalLow', 'criticalHigh', 'female', 'male', 'unit'].some((k) => a[k] !== undefined)) issue('only numeric analytes take units and ranges');
  if (a.low !== undefined && a.high !== undefined && a.low >= a.high) issue('low must be below high');
  if (a.criticalLow !== undefined && a.low !== undefined && a.criticalLow > a.low) issue('criticalLow must not exceed low');
  if (a.criticalHigh !== undefined && a.high !== undefined && a.criticalHigh < a.high) issue('criticalHigh must not be below high');
});

export const analytesSchema = z.array(analyteSchema).min(1).max(40)
  .refine((list) => new Set(list.map((a) => a.code)).size === list.length, 'Analyte codes must be unique within a test');

const numeric = (code, name, unit, extra) => ({ code, name, kind: 'NUMERIC', unit, ...extra });
const choice = (code, name, options, normal) => ({ code, name, kind: 'CHOICE', options, ...(normal ? { normal } : {}) });
const dipstick = ['NEGATIVE', 'TRACE', '1+', '2+', '3+'];

export const DEFAULT_TESTS = [
  {
    code: 'FBC', name: 'Full blood count', specimenType: 'Whole blood (EDTA)',
    analytes: [
      numeric('HB', 'Haemoglobin', 'g/dL', { low: 12, high: 17, criticalLow: 7, criticalHigh: 20, female: { low: 12, high: 15.5 }, male: { low: 13.5, high: 17.5 } }),
      numeric('PCV', 'Packed cell volume', '%', { low: 36, high: 50, female: { low: 36, high: 46 }, male: { low: 40, high: 52 } }),
      numeric('WBC', 'White cell count', 'x10^9/L', { low: 4, high: 11, criticalLow: 2, criticalHigh: 30 }),
      numeric('PLT', 'Platelets', 'x10^9/L', { low: 150, high: 400, criticalLow: 50, criticalHigh: 1000 }),
    ],
  },
  { code: 'MP_RDT', name: 'Malaria parasite (RDT)', specimenType: 'Whole blood', analytes: [choice('MP', 'Malaria antigen', ['NEGATIVE', 'POSITIVE'], ['NEGATIVE'])] },
  { code: 'FBS', name: 'Fasting blood glucose', specimenType: 'Plasma (fluoride)', analytes: [numeric('GLU', 'Glucose', 'mmol/L', { low: 3.9, high: 5.5, criticalLow: 2.5, criticalHigh: 25 })] },
  { code: 'RBS', name: 'Random blood glucose', specimenType: 'Plasma (fluoride)', analytes: [numeric('GLU', 'Glucose', 'mmol/L', { low: 3.9, high: 7.8, criticalLow: 2.5, criticalHigh: 25 })] },
  {
    code: 'LIPID', name: 'Lipid profile', specimenType: 'Serum',
    analytes: [
      numeric('CHOL', 'Total cholesterol', 'mmol/L', { high: 5.2 }),
      numeric('TG', 'Triglycerides', 'mmol/L', { high: 1.7 }),
      numeric('HDL', 'HDL cholesterol', 'mmol/L', { low: 1.0 }),
      numeric('LDL', 'LDL cholesterol', 'mmol/L', { high: 3.4 }),
    ],
  },
  {
    code: 'EUCR', name: 'Electrolytes, urea & creatinine', specimenType: 'Serum',
    analytes: [
      numeric('NA', 'Sodium', 'mmol/L', { low: 135, high: 145, criticalLow: 120, criticalHigh: 160 }),
      numeric('K', 'Potassium', 'mmol/L', { low: 3.5, high: 5.1, criticalLow: 2.5, criticalHigh: 6.5 }),
      numeric('CL', 'Chloride', 'mmol/L', { low: 98, high: 107 }),
      numeric('HCO3', 'Bicarbonate', 'mmol/L', { low: 22, high: 29 }),
      numeric('UREA', 'Urea', 'mmol/L', { low: 2.5, high: 7.1 }),
      numeric('CREAT', 'Creatinine', 'umol/L', { low: 44, high: 106, female: { low: 44, high: 80 }, male: { low: 62, high: 106 } }),
    ],
  },
  {
    code: 'UA', name: 'Urinalysis (dipstick)', specimenType: 'Urine',
    analytes: [choice('PROT', 'Protein', dipstick, ['NEGATIVE']), choice('UGLU', 'Glucose', dipstick, ['NEGATIVE']), choice('BLD', 'Blood', dipstick, ['NEGATIVE'])],
  },
  { code: 'HIV_RDT', name: 'HIV 1/2 (rapid)', specimenType: 'Whole blood', analytes: [choice('HIV', 'HIV 1/2 antibody', ['NON_REACTIVE', 'REACTIVE'], ['NON_REACTIVE'])] },
  { code: 'HBSAG', name: 'Hepatitis B surface antigen', specimenType: 'Serum', analytes: [choice('HBSAG', 'HBsAg', ['NON_REACTIVE', 'REACTIVE'], ['NON_REACTIVE'])] },
  // Pregnancy: no "normal" answer, so no flag is raised either way.
  { code: 'PREG', name: 'Pregnancy test (urine hCG)', specimenType: 'Urine', analytes: [choice('HCG', 'hCG', ['NEGATIVE', 'POSITIVE'])] },
];

// The starter catalog must itself be valid (checked at module load, so a bad edit fails fast).
for (const test of DEFAULT_TESTS) analytesSchema.parse(test.analytes);
