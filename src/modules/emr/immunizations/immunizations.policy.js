// Nigeria routine immunization schedule (NPHCDA), as the Immunization screen shows it. `ageWeeks` is
// the minimum age for the dose; a dose not given 4 weeks after that is a defaulter.
export const VACCINES = [
  { code: 'BCG', name: 'Bacillus Calmette–Guérin (BCG)', ageWeeks: 0 },
  { code: 'OPV0', name: 'Oral Polio Vaccine (OPV 0)', ageWeeks: 0 },
  { code: 'HEPB0', name: 'Hepatitis B (birth dose)', ageWeeks: 0 },
  { code: 'OPV1', name: 'Oral Polio Vaccine (Dose 1)', ageWeeks: 6 },
  { code: 'PENTA1', name: 'Pentavalent Vaccine (Dose 1)', ageWeeks: 6 },
  { code: 'PCV1', name: 'Pneumococcal Conjugate (Dose 1)', ageWeeks: 6 },
  { code: 'ROTA1', name: 'Rotavirus Vaccine (Dose 1)', ageWeeks: 6 },
  { code: 'OPV2', name: 'Oral Polio Vaccine (Dose 2)', ageWeeks: 10 },
  { code: 'PENTA2', name: 'Pentavalent Vaccine (Dose 2)', ageWeeks: 10 },
  { code: 'PCV2', name: 'Pneumococcal Conjugate (Dose 2)', ageWeeks: 10 },
  { code: 'ROTA2', name: 'Rotavirus Vaccine (Dose 2)', ageWeeks: 10 },
  { code: 'OPV3', name: 'Oral Polio Vaccine (Dose 3)', ageWeeks: 14 },
  { code: 'PENTA3', name: 'Pentavalent Vaccine (Dose 3)', ageWeeks: 14 },
  { code: 'PCV3', name: 'Pneumococcal Conjugate (Dose 3)', ageWeeks: 14 },
  { code: 'IPV1', name: 'Inactivated Polio Vaccine (Dose 1)', ageWeeks: 14 },
  { code: 'MV1', name: 'Measles Vaccine (Dose 1)', ageWeeks: 39 },
  { code: 'YF', name: 'Yellow Fever Vaccine', ageWeeks: 39 },
  { code: 'MENA', name: 'Meningococcal A Conjugate', ageWeeks: 39 },
  { code: 'VITA1', name: 'Vitamin A (Dose 1)', ageWeeks: 39 },
  { code: 'MV2', name: 'Measles–Rubella (Dose 2)', ageWeeks: 65 },
];
export const VACCINE_CODES = VACCINES.map((v) => v.code);
export const vaccine = (code) => VACCINES.find((v) => v.code === code);
export const DEFAULT_AFTER_WEEKS = 4;
const WEEK = 7 * 86_400_000;
export const ageInWeeks = (dateOfBirth, at) => Math.floor((at.getTime() - dateOfBirth.getTime()) / WEEK);

/** Antigens this child should have had (4+ weeks past their minimum age) but has not. */
export function missedDoses(dateOfBirth, givenCodes, now = new Date()) {
  const age = ageInWeeks(dateOfBirth, now);
  return VACCINES.filter((v) => !givenCodes.has(v.code) && age >= v.ageWeeks + DEFAULT_AFTER_WEEKS)
    .map((v) => ({ vaccineCode: v.code, vaccineName: v.name, dueAgeWeeks: v.ageWeeks, weeksLate: age - v.ageWeeks }));
}
