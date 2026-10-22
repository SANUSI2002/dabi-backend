// Organization configuration shared by every product: master-data lists, terminology, letter templates
// and the letters generated from them.
//
// Rules enforced here:
//   - every member reads the lists and the terminology (they fill dropdowns and labels);
//   - a list is edited by whoever owns its product: Workforce lists hr.manage, EMR lists catalog.manage,
//     platform-wide and Accounting lists platform.config; a list may add editors (the drug categories and
//     drug classes: the pharmacy, emr.formulary.manage); starter ("system") items can be switched off
//     but not removed; removing an item keeps it on record (soft) so older records still resolve;
//   - terminology: platform.config or hr.manage; letter templates and generating letters: hr.manage or
//     platform.config; generated letters are HR records (hr.read) and keep the text as rendered;
//   - recording a letter as sent records delivery — nothing is mailed from here.
import { withTenant } from '../emr/core/db.js';
import { recordAudit } from '../emr/core/audit.js';
import { updateVersioned } from '../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../emr/core/errors.js';
import { LETTER_TEMPLATES, MASTER_CATEGORIES, MASTER_SEED } from './orgConfig.seed.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, ...permissions) => permissions.some((p) => context.permissions.includes(p));
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });
const EDIT = { workforce: ['hr.manage'], emr: ['catalog.manage'], accounting: ['platform.config'], platform: ['platform.config'] };
export const TERM_KEYS = ['organisation', 'branch', 'department', 'hod', 'deputyHod', 'supervisor', 'lineManager', 'manager', 'seniorManager', 'director', 'executive', 'employee', 'staff'];
const categoryOf = (key) => {
  const c = MASTER_CATEGORIES.find((x) => x.key === key);
  if (!c) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'Unknown list.' });
  return c;
};
// A list may name extra editors beside its product's owner (the pharmacy edits the drug lists).
const editorsOf = (c) => [...EDIT[c.product ?? 'platform'], ...(c.editors ?? [])];
const requireListEditor = (context, key) => {
  if (!can(context, ...editorsOf(categoryOf(key)))) throw new EmrError('PERMISSION_DENIED');
};
const requireLetters = (context) => { if (!can(context, 'hr.manage', 'platform.config')) throw new EmrError('PERMISSION_DENIED'); };

/** Replaces {{tokens}} from `data`; an unknown token becomes a blank line to fill in by hand. */
export const renderTemplate = (body, data) => body.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, k) => (data[k] === undefined || data[k] === '' ? '________' : String(data[k])));

export async function ensureSeeded(tx, context) {
  const present = new Set((await tx.platformMasterItem.groupBy({ by: ['category'], where: org(context) })).map((g) => g.category));
  const missing = MASTER_CATEGORIES.filter((c) => !present.has(c.key));
  if (missing.length) {
    await tx.platformMasterItem.createMany({
      data: missing.flatMap((c) => (MASTER_SEED[c.key] ?? []).map((i, sort) => ({ ...org(context), category: c.key, label: i.label, code: i.code ?? null, active: i.active, system: !!i.system, meta: i.meta ?? {}, sort }))),
    });
  }
  if (!(await tx.platformLetterTemplate.count({ where: org(context) }))) {
    await tx.platformLetterTemplate.createMany({ data: LETTER_TEMPLATES.map((t) => ({ ...org(context), key: t.key, name: t.name, category: t.category, body: t.body, signatories: t.signatories, active: t.active !== false, system: !!t.system })) });
  }
}

export async function overview(context) {
  return withTenant(context, async (tx) => {
    await ensureSeeded(tx, context);
    const [items, terms, templates, letters] = await Promise.all([
      tx.platformMasterItem.findMany({ where: { ...org(context), removedAt: null }, orderBy: [{ category: 'asc' }, { sort: 'asc' }, { createdAt: 'asc' }] }),
      tx.platformTerms.findUnique({ where: { organizationId: context.organizationId } }),
      tx.platformLetterTemplate.findMany({ where: org(context), orderBy: { updatedAt: 'asc' } }),
      can(context, 'hr.read') ? tx.platformLetter.findMany({ where: org(context), orderBy: { generatedAt: 'desc' }, take: 200 }) : [],
    ]);
    const data = Object.fromEntries(MASTER_CATEGORIES.map((c) => [c.key, []]));
    for (const i of items) (data[i.category] ??= []).push({ id: i.id, label: i.label, code: i.code ?? undefined, active: i.active, system: i.system || undefined, meta: Object.keys(i.meta).length ? i.meta : undefined, version: i.version });
    return {
      categories: MASTER_CATEGORIES.map((c) => ({ ...c, editable: can(context, ...editorsOf(c)) })),
      data,
      terms: { overrides: terms?.overrides ?? {}, version: terms?.version ?? 0, editable: can(context, 'platform.config', 'hr.manage') },
      templates: templates.map((t) => ({ key: t.key, name: t.name, category: t.category, body: t.body, signatories: t.signatories, active: t.active, system: t.system || undefined, version: t.version })),
      letters: letters.map((l) => ({ id: l.id, templateKey: l.templateKey, title: l.title, subjectStaffId: l.subjectEmployeeId ?? undefined, reference: l.reference ?? undefined, data: l.data, rendered: l.rendered, generatedBy: l.generatedByUserId, generatedAt: l.generatedAt, sentAt: l.sentAt ?? undefined, sentTo: l.sentTo ?? undefined })),
      canWriteLetters: can(context, 'hr.manage', 'platform.config'),
    };
  });
}

// ---- master data ------------------------------------------------------------------------------------
export async function addItem(context, category, { id, label, code, meta }) {
  requireListEditor(context, category);
  return withTenant(context, async (tx) => {
    await ensureSeeded(tx, context);
    const sort = (await tx.platformMasterItem.count({ where: { ...org(context), category } }));
    let row;
    try {
      row = await tx.platformMasterItem.create({ data: { ...(id ? { id } : {}), ...org(context), category, label, code: code || null, meta: meta ?? {}, sort } });
    } catch (error) { throw uniqueViolation(error, { code_key: 'MASTER_ITEM_IN_USE', label_key: 'MASTER_ITEM_IN_USE', pkey: 'MASTER_ITEM_IN_USE' }) ?? error; }
    await audited(tx, context, 'master_data.added', 'master_item', row.id, [category]);
    return { id: row.id };
  });
}
async function item(tx, context, category, id) {
  const row = await tx.platformMasterItem.findFirst({ where: { ...org(context), category, id, removedAt: null } });
  if (!row) throw new EmrError('HR_RECORD_NOT_FOUND');
  return row;
}
export async function updateItem(context, category, id, expectedVersion, patch) {
  requireListEditor(context, category);
  return withTenant(context, async (tx) => {
    await item(tx, context, category, id);
    const data = Object.fromEntries(Object.entries({ label: patch.label, code: patch.code === '' ? null : patch.code, meta: patch.meta, active: patch.active }).filter(([, v]) => v !== undefined));
    try {
      await updateVersioned(tx.platformMasterItem, { organizationId: context.organizationId, id, expectedVersion, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    } catch (error) { throw uniqueViolation(error, { code_key: 'MASTER_ITEM_IN_USE', label_key: 'MASTER_ITEM_IN_USE' }) ?? error; }
    await audited(tx, context, 'master_data.updated', 'master_item', id, Object.keys(data));
    return { id };
  });
}
export async function removeItem(context, category, id) {
  requireListEditor(context, category);
  return withTenant(context, async (tx) => {
    const row = await item(tx, context, category, id);
    if (row.system) throw new EmrError('INVALID_STATE', { message: 'A starter item cannot be removed; switch it off instead.' });
    await tx.platformMasterItem.updateMany({ where: { ...org(context), id }, data: { removedAt: new Date(), active: false, version: { increment: 1 } } });
    await audited(tx, context, 'master_data.removed', 'master_item', id, [category]);
    return { id, removed: true };
  });
}

// ---- terminology ------------------------------------------------------------------------------------
export async function saveTerms(context, expectedVersion, { overrides }) {
  if (!can(context, 'platform.config', 'hr.manage')) throw new EmrError('PERMISSION_DENIED');
  return withTenant(context, async (tx) => {
    const row = await tx.platformTerms.findUnique({ where: { organizationId: context.organizationId } });
    if (!row) {
      if (expectedVersion !== 0) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: 0 } });
      await tx.platformTerms.create({ data: { ...org(context), overrides, updatedByUserId: context.userId } });
    } else {
      const { count } = await tx.platformTerms.updateMany({ where: { ...org(context), version: expectedVersion }, data: { overrides, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
      if (!count) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: row.version } });
    }
    await audited(tx, context, 'terminology.saved', 'terminology', null, Object.keys(overrides));
    return { saved: true };
  });
}

// ---- letters ----------------------------------------------------------------------------------------
export async function addTemplate(context, input) {
  requireLetters(context);
  return withTenant(context, async (tx) => {
    await ensureSeeded(tx, context);
    try {
      await tx.platformLetterTemplate.create({ data: { ...org(context), key: input.key, name: input.name, category: input.category, body: input.body, signatories: input.signatories, updatedByUserId: context.userId } });
    } catch (error) { throw uniqueViolation(error, { templates_key: 'MASTER_ITEM_IN_USE', key: 'MASTER_ITEM_IN_USE' }) ?? error; }
    await audited(tx, context, 'letter_template.added', 'letter_template', null, [input.key]);
    return { key: input.key };
  });
}
export async function saveTemplate(context, key, expectedVersion, patch) {
  requireLetters(context);
  return withTenant(context, async (tx) => {
    const t = await tx.platformLetterTemplate.findFirst({ where: { ...org(context), key } });
    if (!t) throw new EmrError('HR_RECORD_NOT_FOUND');
    const data = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await updateVersioned(tx.platformLetterTemplate, { organizationId: context.organizationId, id: t.id, expectedVersion, data: { ...data, updatedByUserId: context.userId, updatedAt: new Date() }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'letter_template.updated', 'letter_template', t.id, Object.keys(data));
    return { key };
  });
}
export async function generateLetter(context, { id, templateKey, title, data, subjectStaffId, reference }) {
  requireLetters(context);
  return withTenant(context, async (tx) => {
    await ensureSeeded(tx, context);
    const t = await tx.platformLetterTemplate.findFirst({ where: { ...org(context), key: templateKey } });
    if (!t || !t.active) throw new EmrError('HR_RECORD_NOT_FOUND', { message: 'That letter template is not available.' });
    if (subjectStaffId && !(await tx.wfEmployee.findFirst({ where: { ...org(context), id: subjectStaffId }, select: { id: true } }))) throw new EmrError('EMPLOYEE_NOT_FOUND');
    const values = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]));
    const letter = await tx.platformLetter.create({
      data: { ...(id ? { id } : {}), ...org(context), templateKey, title: title ?? t.name, subjectEmployeeId: subjectStaffId ?? null, reference: reference ?? null, data: values, rendered: renderTemplate(t.body, values), generatedByUserId: context.userId },
    });
    await audited(tx, context, 'letter.generated', 'letter', letter.id, [templateKey]);
    return { id: letter.id };
  });
}
export async function markLetterSent(context, id, { to }) {
  requireLetters(context);
  return withTenant(context, async (tx) => {
    const { count } = await tx.platformLetter.updateMany({ where: { ...org(context), id, sentAt: null }, data: { sentAt: new Date(), sentTo: to, sentByUserId: context.userId } });
    if (!count) throw (await tx.platformLetter.findFirst({ where: { ...org(context), id } })) ? new EmrError('INVALID_STATE', { message: 'This letter is already recorded as sent.' }) : new EmrError('HR_RECORD_NOT_FOUND');
    await audited(tx, context, 'letter.sent', 'letter', id);
    return { id, sent: true };
  });
}

/**
 * The values on one of the organization's lists (seeding the starter lists first), for checking a record
 * against it. An item's value is its code, or its name when it has none.
 */
export async function listCodes(tx, context, category) {
  await ensureSeeded(tx, context);
  const rows = await tx.platformMasterItem.findMany({ where: { ...org(context), category, removedAt: null }, select: { code: true, label: true, active: true } });
  const value = (r) => r.code || r.label;
  return { all: new Set(rows.map(value)), active: new Set(rows.filter((r) => r.active).map(value)) };
}

/**
 * Refuses a value that is not an active item on the organization's list (Settings → Master Data). A record
 * that already holds a value may keep it after the item is switched off: pass it as `current`.
 */
export async function requireListed(tx, context, category, value, { current, what } = {}) {
  if (value === undefined || value === null || value === current) return;
  const { active } = await listCodes(tx, context, category);
  if (!active.has(value)) {
    const list = MASTER_CATEGORIES.find((c) => c.key === category)?.label ?? category;
    throw new EmrError('VALIDATION_FAILED', { message: `${what ?? 'That value'} “${value}” is not on the ${list} list. Add it under Settings → Master Data first.` });
  }
}
