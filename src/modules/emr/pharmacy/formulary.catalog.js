// Hospital formulary: item shape (validated on every edit) and the starter formulary each
// organization receives on first use — common essential medicines.
//
// Doses and maximum daily doses are typical ADULT values, given only as a starting point. Each
// hospital's pharmacy and therapeutics committee must review them before clinical use.
import { z } from 'zod';

export const ROUTES = ['PO', 'SL', 'IV', 'IM', 'SC', 'INHALED', 'TOPICAL', 'PR', 'PV', 'OPHTHALMIC', 'OTIC', 'NASAL'];
const code = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,23}$/, 'Codes are letters, digits and _');
const label = (max) => z.string().trim().min(1).max(max);

export const formularyFields = {
  genericName: label(120),
  brandName: label(120).nullable().optional(),
  form: label(40),
  strength: label(60),
  doseUnit: label(20),
  dispenseUnit: label(20),
  dosePerDispenseUnit: z.number().positive().max(1e6).nullable().optional(),
  maxDailyDose: z.number().positive().max(1e6).nullable().optional(),
  defaultRoute: z.enum(ROUTES),
  drugClasses: z.array(code).max(10).optional(),
  controlled: z.boolean().optional(),
  highAlert: z.boolean().optional(),
  reorderLevel: z.number().int().min(0).max(1e6).optional(),
};
export const formularyCode = code;

const item = (codeValue, genericName, form, strength, doseUnit, dispenseUnit, dosePerDispenseUnit, maxDailyDose, defaultRoute, extra = {}) => ({
  code: codeValue, genericName, form, strength, doseUnit, dispenseUnit, dosePerDispenseUnit, maxDailyDose, defaultRoute,
  drugClasses: [], controlled: false, highAlert: false, reorderLevel: 50, ...extra,
});

export const DEFAULT_FORMULARY = [
  item('PARA500', 'Paracetamol', 'Tablet', '500 mg', 'mg', 'tablet', 500, 4000, 'PO', { drugClasses: ['ANALGESIC'], reorderLevel: 500 }),
  item('IBU400', 'Ibuprofen', 'Tablet', '400 mg', 'mg', 'tablet', 400, 2400, 'PO', { drugClasses: ['NSAID'], reorderLevel: 200 }),
  item('DICLO75_INJ', 'Diclofenac', 'Injection', '75 mg/3 mL', 'mg', 'ampoule', 75, 150, 'IM', { drugClasses: ['NSAID'] }),
  item('AMOX500', 'Amoxicillin', 'Capsule', '500 mg', 'mg', 'capsule', 500, 3000, 'PO', { drugClasses: ['PENICILLIN', 'BETA_LACTAM'], reorderLevel: 300 }),
  item('AMOXCLAV625', 'Amoxicillin/clavulanic acid', 'Tablet', '500/125 mg', 'tablet', 'tablet', 1, 3, 'PO', { drugClasses: ['PENICILLIN', 'BETA_LACTAM'] }),
  item('CEFTRI1G_INJ', 'Ceftriaxone', 'Injection', '1 g vial', 'g', 'vial', 1, 4, 'IV', { drugClasses: ['CEPHALOSPORIN', 'BETA_LACTAM'] }),
  item('METRO400', 'Metronidazole', 'Tablet', '400 mg', 'mg', 'tablet', 400, 2400, 'PO', { drugClasses: ['NITROIMIDAZOLE'] }),
  item('CIPRO500', 'Ciprofloxacin', 'Tablet', '500 mg', 'mg', 'tablet', 500, 1500, 'PO', { drugClasses: ['FLUOROQUINOLONE'] }),
  item('AL20_120', 'Artemether/lumefantrine', 'Tablet', '20/120 mg', 'tablet', 'tablet', 1, 8, 'PO', { drugClasses: ['ANTIMALARIAL'], reorderLevel: 240 }),
  item('METF500', 'Metformin', 'Tablet', '500 mg', 'mg', 'tablet', 500, 3000, 'PO', { drugClasses: ['BIGUANIDE'] }),
  item('AMLO5', 'Amlodipine', 'Tablet', '5 mg', 'mg', 'tablet', 5, 10, 'PO', { drugClasses: ['CALCIUM_CHANNEL_BLOCKER'] }),
  item('OMEP20', 'Omeprazole', 'Capsule', '20 mg', 'mg', 'capsule', 20, 80, 'PO', { drugClasses: ['PPI'] }),
  item('PRED5', 'Prednisolone', 'Tablet', '5 mg', 'mg', 'tablet', 5, 60, 'PO', { drugClasses: ['CORTICOSTEROID'] }),
  item('FESO4_200', 'Ferrous sulfate', 'Tablet', '200 mg', 'mg', 'tablet', 200, 600, 'PO', { drugClasses: ['IRON'] }),
  item('ZINC20', 'Zinc sulfate', 'Dispersible tablet', '20 mg', 'mg', 'tablet', 20, 40, 'PO'),
  item('ORS', 'Oral rehydration salts', 'Sachet', '20.5 g', 'sachet', 'sachet', 1, null, 'PO', { reorderLevel: 100 }),
  item('SALB_INH', 'Salbutamol', 'Inhaler', '100 mcg/puff', 'puff', 'inhaler', null, 16, 'INHALED', { drugClasses: ['BETA_AGONIST'], reorderLevel: 20 }),
  item('INS_SOL', 'Insulin, soluble', 'Injection', '100 IU/mL, 10 mL vial', 'IU', 'vial', null, null, 'SC', { drugClasses: ['INSULIN'], highAlert: true, reorderLevel: 10 }),
  item('TRAM50', 'Tramadol', 'Capsule', '50 mg', 'mg', 'capsule', 50, 400, 'PO', { drugClasses: ['OPIOID'], controlled: true, reorderLevel: 100 }),
  item('MORPH10_INJ', 'Morphine', 'Injection', '10 mg/mL ampoule', 'mg', 'ampoule', 10, null, 'IV', { drugClasses: ['OPIOID'], controlled: true, highAlert: true, reorderLevel: 20 }),
];

const starter = z.object({ code, ...formularyFields }).strict();
for (const entry of DEFAULT_FORMULARY) starter.parse(entry); // fail fast on a bad edit
