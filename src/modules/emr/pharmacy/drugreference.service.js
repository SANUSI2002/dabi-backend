// Drug search for prescribers: the hospital formulary (what the pharmacy stocks) and the EMDEX national
// drug index, searched together on the server so the EMDEX token never reaches the browser.
//
// Picking an EMDEX product (POST /pharmacy/formulary/from-reference) resolves it to a formulary code:
// the formulary item already linked to that EMDEX product, else one with the same generic name, strength
// and form, else a new formulary item made from the EMDEX record (re-read here, never taken from the
// browser). A new item has no stock, no maximum daily dose and no drug classes until the pharmacy adds
// them — the prescription still goes to pharmacy review, and the item carries a note saying so.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { EmrError, uniqueViolation } from '../core/errors.js';
import { emdexCapabilities, emdexRequest } from './emdex.transport.js';
import { normalizeProduct, normalizeResults } from './emdex.normalize.js';
import { listFormulary } from './stock.service.js';
import { ensureFormulary } from './pharmacy.shared.js';

const org = (context) => ({ organizationId: context.organizationId });
const key = (s) => (s ?? '').toLowerCase().replace(/\s+/g, '');

/** What the prescriber sees: formulary matches first (with stock), then EMDEX products not yet in it. */
export async function searchDrugs(context, { q }) {
  const formulary = await listFormulary(context, { q });
  if (!emdexCapabilities().credentialsConfigured) return { formulary, reference: [], referenceStatus: 'not_configured' };
  let reference = [];
  let referenceStatus = 'ok';
  try {
    const [generics, brands] = await Promise.all([emdexRequest('genericSearch', { keyword: q }), emdexRequest('brandSearch', { keyword: q, form: '', strength: '' })]);
    reference = [...normalizeResults('generic', generics.data), ...normalizeResults('brand', brands.data)];
  } catch (error) {
    referenceStatus = error.code === 'EMDEX_NOT_CONFIGURED' ? 'not_configured' : 'unavailable';
  }
  // say which EMDEX products the formulary already has, so they are prescribed from it
  const linked = await withTenant(context, (tx) => tx.emrFormularyItem.findMany({ where: { ...org(context), referenceSource: 'EMDEX', referenceId: { in: reference.map((r) => r.referenceId) } }, select: { code: true, referenceId: true } }));
  const byRef = new Map(linked.map((l) => [l.referenceId, l.code]));
  const byName = new Map(formulary.map((f) => [`${key(f.genericName)}|${key(f.strength)}|${key(f.form)}`, f.code]));
  return {
    formulary,
    reference: reference.slice(0, 20).map((r) => ({ ...r, formularyCode: byRef.get(r.referenceId) ?? byName.get(`${key(r.genericName)}|${key(r.strength)}|${key(r.form)}`) ?? null })),
    referenceStatus,
  };
}

const ROUTE_BY_FORM = [
  [/inject|infus|vial|ampoule/i, 'IV'], [/cream|ointment|gel|lotion|topical/i, 'TOPICAL'], [/eye/i, 'OPHTHALMIC'], [/ear/i, 'OTIC'], [/nasal/i, 'NASAL'],
  [/inhal|nebul/i, 'INHALED'], [/supposit|rectal/i, 'PR'], [/pessar|vaginal/i, 'PV'], [/sublingual/i, 'SL'],
];
const DISPENSE_BY_FORM = [[/tablet|caplet/i, 'tablet'], [/capsule/i, 'capsule'], [/syrup|suspension|solution|elixir/i, 'bottle'], [/inject|vial/i, 'vial'], [/ampoule/i, 'ampoule'], [/cream|ointment|gel/i, 'tube'], [/inhal/i, 'inhaler'], [/supposit/i, 'suppository']];
const pick = (rules, form, fallback) => rules.find(([re]) => re.test(form))?.[1] ?? fallback;
/** The dose unit is the strength's first unit: "500mg" → mg, "250 mg/5 ml" → mg, "0.5%" → none. */
const doseUnitOf = (strength) => /([a-zA-Zµμ]+)/.exec(strength ?? '')?.[1]?.replace(/[µμ]/, 'mc').toLowerCase() ?? null;
const codeFor = (r) => `EMX_${r.kind === 'brand' ? 'B' : 'G'}${r.referenceId}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 24);

/** Resolves a picked EMDEX product to a formulary code (adding it, not stocked, if the hospital lacks it). */
export async function fromReference(context, { kind, id }) {
  let product;
  try {
    product = normalizeProduct(kind, (await emdexRequest(kind === 'brand' ? 'brandDetails' : 'genericDetails', { id })).data, id);
  } catch (error) {
    throw new EmrError('DRUG_REFERENCE_UNAVAILABLE', { details: { reason: error.code ?? 'EMDEX_UNAVAILABLE' } });
  }
  return withTenant(context, async (tx) => {
    await ensureFormulary(tx, context);
    const linked = await tx.emrFormularyItem.findFirst({ where: { ...org(context), referenceSource: 'EMDEX', referenceId: product.referenceId } });
    if (linked) return { code: linked.code, doseUnit: linked.doseUnit, created: false };
    const same = (await tx.emrFormularyItem.findMany({ where: { ...org(context), active: true, genericName: { equals: product.genericName, mode: 'insensitive' } } }))
      .find((f) => key(f.strength) === key(product.strength) && key(f.form) === key(product.form));
    if (same) return { code: same.code, doseUnit: same.doseUnit, created: false };
    const doseUnit = doseUnitOf(product.strength);
    if (!doseUnit) throw new EmrError('VALIDATION_FAILED', { message: `EMDEX gives no dose unit for ${product.genericName} ${product.strength ?? ''}; ask the pharmacy to add it to the formulary.` });
    try {
      const item = await tx.emrFormularyItem.create({
        data: {
          ...org(context), code: codeFor(product), genericName: product.genericName.slice(0, 120), brandName: product.brandName?.slice(0, 120) ?? null, form: (product.form ?? 'unspecified').slice(0, 40),
          strength: (product.strength ?? '').slice(0, 60), doseUnit, dispenseUnit: pick(DISPENSE_BY_FORM, product.form ?? '', 'unit'), defaultRoute: pick(ROUTE_BY_FORM, product.form ?? '', 'PO'),
          manufacturer: product.manufacturer?.slice(0, 120) ?? null, referenceSource: 'EMDEX', referenceId: product.referenceId, addedByUserId: context.userId,
          pharmacistNotes: 'Added from EMDEX by a prescriber. Not stocked: set the maximum daily dose, drug classes and stock before relying on dose and allergy-class checks.',
        },
      });
      await recordAudit(tx, context, { action: 'formulary.added_from_reference', resourceType: 'formulary_item', resourceId: item.id, changedFields: ['EMDEX', product.referenceId] });
      return { code: item.code, doseUnit: item.doseUnit, created: true };
    } catch (error) {
      throw uniqueViolation(error, { reference_key: 'FORMULARY_CODE_IN_USE', code: 'FORMULARY_CODE_IN_USE' }) ?? error;
    }
  });
}
