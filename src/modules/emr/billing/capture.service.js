// Charge capture: turns a visit's clinical records into charges, exactly once each.
//
// Billing reads (never writes) the clinical modules' tables inside the same tenant transaction:
//   CONSULTATION  one per visit (not for telemedicine visits — that fee is taken at booking)
//   LAB           each ordered test once its specimen is collected
//   MEDICATION    each dispense line; later returns become credits at the price charged
//   BED_DAY       each night admitted, at the ward occupied that night
// Every charge carries a unique (source_type, source_key); inserting with ON CONFLICT DO NOTHING
// makes capture safe to run any number of times, concurrently. Items without a price are reported
// back — never charged at zero.
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { EmrError } from '../core/errors.js';
import { bedDays, lineAmounts, returnCreditDue } from './billing.policy.js';

const LAB_BILLABLE = ['COLLECTED', 'IN_PROGRESS', 'COMPLETED'];

function priceLookup(prices) {
  const byKey = new Map(prices.map((p) => [`${p.category}:${p.reference}`, p]));
  return (category, ...references) => references.map((r) => byKey.get(`${category}:${r}`)).find(Boolean) ?? null;
}

const chargeRow = (context, encounter, { price, priceItemId, unitPriceMinor, taxRateBp, currency, category, description, quantity, sourceType, sourceKey, serviceAt }) => {
  const unit = unitPriceMinor ?? price.unitPriceMinor;
  const rate = taxRateBp ?? price.taxRateBp;
  return {
    organizationId: context.organizationId, patientId: encounter.patientId, encounterId: encounter.id,
    priceItemId: price?.id ?? priceItemId ?? null, category, description, quantity, unitPriceMinor: unit, taxRateBp: rate,
    ...lineAmounts(quantity, unit, rate), currency: currency ?? price.currency,
    sourceType, sourceKey, serviceAt, createdByUserId: context.userId,
  };
};

/** Runs inside an existing tenant transaction; returns { created, unpriced }. */
export async function captureInTx(tx, context, encounterId) {
  const org = context.organizationId;
  const encounter = await tx.emrEncounter.findFirst({ where: { organizationId: org, id: encounterId }, select: { id: true, patientId: true, class: true, status: true, source: true, arrivedAt: true } });
  if (!encounter) throw new EmrError('ENCOUNTER_NOT_FOUND');
  if (encounter.status === 'CANCELLED') return { created: 0, unpriced: [] };
  const price = priceLookup(await tx.emrPriceItem.findMany({ where: { organizationId: org, active: true } }));
  const existing = new Set((await tx.emrCharge.findMany({ where: { organizationId: org, encounterId, sourceKey: { not: null } }, select: { sourceType: true, sourceKey: true } }))
    .map((c) => `${c.sourceType}:${c.sourceKey}`));
  const rows = [];
  const unpriced = [];
  const add = (category, references, fields) => {
    if (existing.has(`${fields.sourceType}:${fields.sourceKey}`)) return;
    const found = price(category, ...references);
    if (!found) { unpriced.push({ category, reference: references[0], description: fields.description }); return; }
    rows.push(chargeRow(context, encounter, { ...fields, price: found, category }));
  };

  if (encounter.source !== 'TELEMEDICINE') {
    add('CONSULTATION', [encounter.class], { description: `Consultation (${encounter.class.toLowerCase()})`, quantity: 1, sourceType: 'ENCOUNTER', sourceKey: encounter.id, serviceAt: encounter.arrivedAt });
  }

  const labItems = await tx.emrLabOrderItem.findMany({
    where: { organizationId: org, order: { encounterId, status: { in: LAB_BILLABLE } } },
    select: { id: true, testCode: true, testName: true, order: { select: { collectedAt: true } } },
  });
  for (const item of labItems) {
    add('LAB', [item.testCode], { description: item.testName, quantity: 1, sourceType: 'LAB_ORDER_ITEM', sourceKey: item.id, serviceAt: item.order.collectedAt });
  }

  const dispensed = await tx.emrDispenseLine.findMany({
    where: { organizationId: org, dispense: { prescription: { encounterId } } },
    select: { id: true, quantity: true, quantityReturned: true, prescriptionItemId: true, dispense: { select: { dispensedAt: true } } },
  });
  const items = await tx.emrPrescriptionItem.findMany({ where: { organizationId: org, id: { in: [...new Set(dispensed.map((l) => l.prescriptionItemId))] } }, select: { id: true, drugCode: true, drugName: true, strength: true, dispenseUnit: true } });
  for (const line of dispensed) {
    const item = items.find((i) => i.id === line.prescriptionItemId);
    add('MEDICATION', [item.drugCode], { description: `${item.drugName} ${item.strength} (${item.dispenseUnit})`, quantity: line.quantity, sourceType: 'DISPENSE_LINE', sourceKey: line.id, serviceAt: line.dispense.dispensedAt });
  }

  const admission = await tx.emrAdmission.findFirst({
    where: { organizationId: org, encounterId, status: { not: 'CANCELLED' } },
    include: { assignments: { orderBy: { startedAt: 'asc' } } },
  });
  if (admission) {
    const wards = await tx.emrWard.findMany({ where: { organizationId: org, id: { in: admission.assignments.map((a) => a.wardId) } }, select: { id: true, code: true, kind: true, name: true } });
    for (const day of bedDays({ admission, assignments: admission.assignments })) {
      const ward = wards.find((w) => w.id === day.wardId);
      add('BED_DAY', [ward.code, ward.kind], { description: `Bed-day, ${ward.name} (${day.date})`, quantity: 1, sourceType: 'BED_DAY', sourceKey: `${admission.id}:${day.date}`, serviceAt: new Date(`${day.date}T00:00:00.000Z`) });
    }
  }

  let created = rows.length ? (await tx.emrCharge.createMany({ data: rows, skipDuplicates: true })).count : 0;

  // Credits for medicine returned after its line was charged — at the unit price charged.
  const returned = dispensed.filter((l) => l.quantityReturned > 0);
  if (returned.length) {
    const lineCharges = await tx.emrCharge.findMany({ where: { organizationId: org, encounterId, sourceType: { in: ['DISPENSE_LINE', 'DISPENSE_RETURN'] } } });
    const credits = [];
    for (const line of returned) {
      const charged = lineCharges.find((c) => c.sourceType === 'DISPENSE_LINE' && c.sourceKey === line.id);
      if (!charged) continue; // the line itself was unpriced, so there is nothing to credit
      const credited = -lineCharges.filter((c) => c.sourceType === 'DISPENSE_RETURN' && c.sourceKey.startsWith(`${line.id}:`)).reduce((sum, c) => sum + c.quantity, 0);
      const due = returnCreditDue(line.quantityReturned, credited);
      if (!due) continue;
      credits.push(chargeRow(context, encounter, {
        category: 'MEDICATION', description: `Returned: ${charged.description}`, quantity: -due,
        priceItemId: charged.priceItemId, unitPriceMinor: charged.unitPriceMinor, taxRateBp: charged.taxRateBp, currency: charged.currency,
        sourceType: 'DISPENSE_RETURN', sourceKey: `${line.id}:${line.quantityReturned}`, serviceAt: new Date(),
      }));
    }
    if (credits.length) created += (await tx.emrCharge.createMany({ data: credits, skipDuplicates: true })).count;
  }
  return { created, unpriced };
}

export async function captureCharges(context, encounterId) {
  return withTenant(context, async (tx) => {
    const result = await captureInTx(tx, context, encounterId);
    if (result.created) await recordAudit(tx, context, { action: 'billing.captured', resourceType: 'encounter', resourceId: encounterId, changedFields: [`charges:${result.created}`] });
    return result;
  });
}
