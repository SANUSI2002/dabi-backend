// Hospital catalogs managed from Settings: the diagnosis list (ICD-11) clinicians pick from, and patient
// categories (fee-exempt or not). A starter set arrives on first use; entries are edited or
// deactivated, never deleted, so records that used a code keep it.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { updateVersioned } from '../core/concurrency.js';
import { uniqueViolation } from '../core/errors.js';

// The common primary-care diagnoses (ICD-11 MMS). A starting point — each hospital adds its own.
const STARTER_DIAGNOSES = [
  ['1F40', 'Malaria, uncomplicated', 'Infectious diseases', false, true], ['1D40', 'Sepsis', 'Infectious diseases', false, false],
  ['CA07', 'Upper respiratory infection', 'Respiratory', false, false], ['1A00', 'Cholera', 'Infectious diseases', false, true],
  ['DA92', 'Functional dyspepsia', 'Digestive', false, false], ['GC08', 'Urinary tract infection', 'Genitourinary', false, false],
  ['EA80', 'Tinea / skin infection', 'Skin', false, false], ['BA00', 'Essential hypertension', 'Circulatory', true, false],
  ['5A11', 'Type 2 diabetes mellitus', 'Endocrine', true, false], ['CA23', 'Asthma', 'Respiratory', true, false],
  ['1B10', 'Tuberculosis of lung', 'Infectious diseases', false, true], ['KA20', 'Disorder of low birth weight', 'Perinatal', false, false],
  ['ME24', 'Preterm labour', 'Pregnancy & childbirth', false, false], ['DA61', 'Peptic ulcer disease', 'Digestive', false, false],
  ['1E31', 'Measles', 'Infectious diseases', false, true], ['5B50', 'Moderate acute malnutrition', 'Nutrition', false, false],
  ['5B51', 'Severe acute malnutrition', 'Nutrition', false, false],
];
const STARTER_CATEGORIES = [
  ['GEN', 'General', false, null], ['U5', 'Under-5', true, 'Free child health'], ['ANC', 'Pregnant women', true, 'Free MCH services'],
  ['ELDER', 'Elderly (65+)', true, 'Senior citizen waiver'], ['STAFF', 'Staff and family', true, 'Staff benefit'], ['INDIG', 'Indigent', true, 'LGA-supported'],
  ['NHIS', 'NHIS enrollee', false, 'Insurance covered'], ['PVT', 'Private', false, null], ['VIP', 'VIP', false, null],
];

const KINDS = {
  diagnoses: {
    model: (tx) => tx.emrDiagnosisCatalog,
    starter: () => STARTER_DIAGNOSES.map(([code, name, chapter, ncd, notifiable]) => ({ code, name, chapter, ncd, notifiable })),
    conflict: 'DIAGNOSIS_CODE_IN_USE',
    present: (r) => ({ id: r.id, code: r.code, name: r.name, chapter: r.chapter, ncd: r.ncd, notifiable: r.notifiable, active: r.active, version: r.version }),
  },
  categories: {
    model: (tx) => tx.emrPatientCategory,
    starter: () => STARTER_CATEGORIES.map(([code, name, exempt, reason]) => ({ code, name, exempt, reason })),
    conflict: 'CATEGORY_CODE_IN_USE',
    present: (r) => ({ id: r.id, code: r.code, name: r.name, exempt: r.exempt, reason: r.reason, active: r.active, version: r.version }),
  },
};

async function ensureStarter(tx, context, kind) {
  const model = KINDS[kind].model(tx);
  if (await model.count({ where: { organizationId: context.organizationId } })) return;
  await model.createMany({ data: KINDS[kind].starter().map((row) => ({ ...row, organizationId: context.organizationId })), skipDuplicates: true });
}

export async function listCatalog(context, kind, { includeInactive }) {
  return withTenant(context, async (tx) => {
    await ensureStarter(tx, context, kind);
    const rows = await KINDS[kind].model(tx).findMany({ where: { organizationId: context.organizationId, ...(includeInactive ? {} : { active: true }) }, orderBy: { code: 'asc' } });
    return { items: rows.map(KINDS[kind].present) };
  });
}

export async function addEntry(context, kind, input) {
  return withTenant(context, async (tx) => {
    await ensureStarter(tx, context, kind);
    let row;
    try {
      row = await KINDS[kind].model(tx).create({ data: { ...input, organizationId: context.organizationId } });
    } catch (error) {
      throw uniqueViolation(error, { code: KINDS[kind].conflict }) ?? error;
    }
    await recordAudit(tx, context, { action: `catalog.${kind}.added`, resourceType: `catalog_${kind}`, resourceId: row.id });
    return KINDS[kind].present(row);
  });
}

export async function updateEntry(context, kind, id, expectedVersion, changes) {
  return withTenant(context, async (tx) => {
    const row = await updateVersioned(KINDS[kind].model(tx), { organizationId: context.organizationId, id, expectedVersion, data: changes, notFoundCode: 'CATALOG_ENTRY_NOT_FOUND' });
    await recordAudit(tx, context, { action: `catalog.${kind}.updated`, resourceType: `catalog_${kind}`, resourceId: id, changedFields: Object.keys(changes) });
    return KINDS[kind].present(row);
  });
}
