// Workforce people & organization structure. Employees are HR records (optionally linked to a Sabi
// user); departments carry their leadership (every change logged) and members; job positions, roles,
// employee types and tags are the organization's own lists. Documents go Requested → Uploaded →
// Approved | Rejected. Notes, disciplinary actions, bonus entries and qualifications are append-only.
// Bank details are only returned to holders of hr.sensitive.
import prisma from '../../../config/db.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';

const STARTER_EMPLOYEE_TYPES = ['Permanent', 'Contract', 'Locum', 'NYSC / Corps Member', 'Volunteer'];
const STARTER_ACTION_TYPES = [['Verbal Warning', false], ['Written Warning', false], ['Suspension', true], ['Termination Notice', true]];
const SENSITIVE = ['dob', 'maritalStatus', 'address', 'lga', 'state', 'bankName', 'accountNumber', 'bankBranch'];
const DATE_FIELDS = ['hireDate', 'dob', 'dateJoining', 'contractEndDate'];
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const canSeeSensitive = (context) => context.permissions.includes('hr.sensitive');
const org = (context) => ({ organizationId: context.organizationId });

/** The organization's own name, for its headquarters record (read outside the tenant transaction). */
async function organizationName(context) {
  const identity = await prisma.identityOrganization.findUnique({ where: { id: context.organizationId }, select: { organisation: { select: { name: true, address: true, state: true, country: true } } } });
  return identity?.organisation ?? null;
}

async function ensureStarters(tx, context, hq) {
  if (!await tx.wfCompany.count({ where: org(context) })) {
    await tx.wfCompany.create({ data: { ...org(context), name: hq?.name ?? 'Headquarters', code: 'HQ', isHeadquarters: true, address: hq?.address ?? null, state: hq?.state ?? null, country: hq?.country ?? 'Nigeria' } });
  }
  if (!await tx.wfEmployeeType.count({ where: org(context) })) {
    await tx.wfEmployeeType.createMany({ data: STARTER_EMPLOYEE_TYPES.map((name) => ({ ...org(context), name })), skipDuplicates: true });
  }
  if (!await tx.wfActionType.count({ where: org(context) })) {
    await tx.wfActionType.createMany({ data: STARTER_ACTION_TYPES.map(([name, blockOption]) => ({ ...org(context), name, blockOption })), skipDuplicates: true });
  }
}

const presentEmployee = (context) => (e) => {
  const row = {
    id: e.id, userId: e.userId, name: e.name, role: e.role, cadre: e.cadre, phone: e.phone, email: e.email, hireDate: isoDay(e.hireDate), license: e.license,
    status: e.status, gender: e.gender, emergencyContactName: e.emergencyContactName, emergencyContactPhone: e.emergencyContactPhone,
    emergencyContactRelation: e.emergencyContactRelation, qualification: e.qualification, companyId: e.companyId, departmentId: e.departmentId,
    jobPositionId: e.jobPositionId, jobRoleId: e.jobRoleId, employeeTypeId: e.employeeTypeId, reportingManagerId: e.reportingManagerId,
    dateJoining: isoDay(e.dateJoining), contractEndDate: isoDay(e.contractEndDate), workEmail: e.workEmail, workPhone: e.workPhone, tagIds: e.tagIds, version: e.version,
  };
  if (canSeeSensitive(context)) Object.assign(row, { dob: isoDay(e.dob), maritalStatus: e.maritalStatus, address: e.address, lga: e.lga, state: e.state, bankName: e.bankName, accountNumber: e.accountNumber, bankBranch: e.bankBranch });
  return row;
};

export async function overview(context) {
  const hq = await organizationName(context);
  return withTenant(context, async (tx) => {
    await ensureStarters(tx, context, hq);
    const where = org(context);
    const [companies, departments, hodChanges, jobPositions, jobRoles, employeeTypes, tags, employees, documents, actionTypes, disciplinary, notes, bonus, qualifications, policies] = await Promise.all([
      tx.wfCompany.findMany({ where, orderBy: [{ isHeadquarters: 'desc' }, { name: 'asc' }] }),
      tx.wfDepartment.findMany({ where, include: { members: { select: { employeeId: true } } }, orderBy: { name: 'asc' } }),
      tx.wfHodChange.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }),
      tx.wfJobPosition.findMany({ where, orderBy: { name: 'asc' } }),
      tx.wfJobRole.findMany({ where, orderBy: { name: 'asc' } }),
      tx.wfEmployeeType.findMany({ where, orderBy: { createdAt: 'asc' } }),
      tx.wfTag.findMany({ where, orderBy: { name: 'asc' } }),
      tx.wfEmployee.findMany({ where, orderBy: { name: 'asc' } }),
      tx.wfEmployeeDocument.findMany({ where, orderBy: { createdAt: 'desc' } }),
      tx.wfActionType.findMany({ where, orderBy: { createdAt: 'asc' } }),
      tx.wfDisciplinaryAction.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 }),
      tx.wfEmployeeNote.findMany({ where, orderBy: { createdAt: 'desc' }, take: 2000 }),
      tx.wfBonusEntry.findMany({ where, orderBy: { createdAt: 'desc' } }),
      tx.wfQualification.findMany({ where, orderBy: { dateObtained: 'desc' } }),
      tx.wfPolicy.findMany({ where, orderBy: { updatedAt: 'desc' } }),
    ]);
    const names = await userNameMap(tx, [...hodChanges.map((h) => h.changedByUserId), ...notes.map((n) => n.byUserId), ...bonus.map((b) => b.byUserId)]);
    const nameOf = (id) => names.get(id) ?? 'Unknown staff member';
    const points = new Map();
    for (const b of [...bonus].reverse()) {
      const entry = points.get(b.employeeId) ?? { employeeId: b.employeeId, points: 0, history: [] };
      entry.points += b.delta;
      entry.history.unshift({ delta: b.delta, reason: b.reason, at: b.createdAt, by: nameOf(b.byUserId) });
      points.set(b.employeeId, entry);
    }
    await recordAudit(tx, context, { action: 'hr.viewed', resourceType: 'hr' });
    return {
      companies: companies.map((c) => ({ id: c.id, name: c.name, code: c.code, isHeadquarters: c.isHeadquarters, address: c.address ?? '', lga: c.lga ?? '', state: c.state ?? '', country: c.country, version: c.version })),
      departments: departments.map((d) => ({
        id: d.id, name: d.name, code: d.code, description: d.description, companyIds: d.companyIds, status: d.status, hodId: d.hodEmployeeId, deputyHodId: d.deputyHodEmployeeId,
        staffIds: d.members.map((m) => m.employeeId), parentDepartmentId: d.parentDepartmentId, createdAt: d.createdAt, version: d.version,
      })),
      hodChanges: hodChanges.map((h) => ({ id: h.id, departmentId: h.departmentId, role: h.role, previousStaffId: h.previousEmployeeId, newStaffId: h.newEmployeeId, effectiveDate: isoDay(h.effectiveDate), reason: h.reason, changedBy: nameOf(h.changedByUserId), at: h.createdAt })),
      jobPositions: jobPositions.map((p) => ({ id: p.id, name: p.name, departmentId: p.departmentId })),
      jobRoles: jobRoles.map((r) => ({ id: r.id, name: r.name, jobPositionId: r.jobPositionId })),
      employeeTypes: employeeTypes.map((t) => ({ id: t.id, name: t.name })),
      tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color })),
      employees: employees.map(presentEmployee(context)),
      documents: documents.map((d) => ({ id: d.id, employeeId: d.employeeId, title: d.title, category: d.category, status: d.status, issueDate: isoDay(d.issueDate), expiryDate: isoDay(d.expiryDate), notifyBeforeDays: d.notifyBeforeDays, rejectReason: d.rejectReason, version: d.version })),
      actionTypes: actionTypes.map((a) => ({ id: a.id, name: a.name, blockOption: a.blockOption })),
      disciplinaryActions: disciplinary.map((a) => ({ id: a.id, employeeIds: a.employeeIds, actionTypeId: a.actionTypeId, description: a.description, unit: a.unit, amount: a.amount, startDate: isoDay(a.startDate), attachment: a.attachment })),
      notes: notes.map((n) => ({ id: n.id, employeeId: n.employeeId, note: n.note, by: nameOf(n.byUserId), at: n.createdAt })),
      bonusPoints: [...points.values()],
      qualifications: qualifications.map((q) => ({ id: q.id, employeeId: q.employeeId, title: q.title, issuingBody: q.issuingBody, dateObtained: isoDay(q.dateObtained), certificateRef: q.certificateRef })),
      policies: policies.map((p) => ({ id: p.id, category: p.category, title: p.title, purpose: p.purpose, body: p.body, updatedAt: p.updatedAt, version: p.version })),
    };
  });
}

// ---- employees ------------------------------------------------------------------------------------
async function checkReferences(tx, context, patch, employeeId) {
  const checks = [
    ['companyId', tx.wfCompany], ['departmentId', tx.wfDepartment], ['jobPositionId', tx.wfJobPosition], ['jobRoleId', tx.wfJobRole], ['employeeTypeId', tx.wfEmployeeType],
  ];
  for (const [field, model] of checks) {
    if (patch[field] && !await model.count({ where: { ...org(context), id: patch[field] } })) throw new EmrError('VALIDATION_FAILED', { message: `Unknown ${field.replace(/Id$/, '')}.` });
  }
  for (const tagId of patch.tagIds ?? []) {
    if (!await tx.wfTag.count({ where: { ...org(context), id: tagId } })) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown tag.' });
  }
  if (patch.reportingManagerId) {
    // Walk up the chain: an employee can never end up managing themselves.
    let cursor = patch.reportingManagerId;
    for (let depth = 0; cursor && depth < 50; depth += 1) {
      if (cursor === employeeId) throw new EmrError('VALIDATION_FAILED', { message: 'That would make this employee report to themselves.' });
      const manager = await tx.wfEmployee.findFirst({ where: { ...org(context), id: cursor }, select: { reportingManagerId: true } });
      if (!manager) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown reporting manager.' });
      cursor = manager.reportingManagerId;
    }
  }
}
const toData = (input) => Object.fromEntries(Object.entries(input).map(([k, v]) => [k, DATE_FIELDS.includes(k) ? toDate(v) : v]));

export async function createEmployee(context, input) {
  if (!canSeeSensitive(context) && SENSITIVE.some((k) => input[k] !== undefined)) throw new EmrError('PERMISSION_DENIED');
  return withTenant(context, async (tx) => {
    await checkReferences(tx, context, input, null);
    const hq = input.companyId ?? (await tx.wfCompany.findFirst({ where: { ...org(context), isHeadquarters: true }, select: { id: true } }))?.id ?? null;
    let row;
    try {
      row = await tx.wfEmployee.create({ data: { ...org(context), ...toData(input), companyId: hq, status: 'ACTIVE' } });
    } catch (error) {
      throw uniqueViolation(error, { user_id: 'EMPLOYEE_USER_LINKED', pkey: 'HR_CODE_IN_USE' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'employee.created', resourceType: 'employee', resourceId: row.id });
    return presentEmployee(context)(row);
  });
}

export async function updateEmployee(context, employeeId, expectedVersion, patch) {
  if (!canSeeSensitive(context) && SENSITIVE.some((k) => patch[k] !== undefined)) throw new EmrError('PERMISSION_DENIED');
  return withTenant(context, async (tx) => {
    await checkReferences(tx, context, patch, employeeId);
    let row;
    try {
      row = await updateVersioned(tx.wfEmployee, { organizationId: context.organizationId, id: employeeId, expectedVersion, data: { ...toData(patch), updatedAt: new Date() }, notFoundCode: 'EMPLOYEE_NOT_FOUND' });
    } catch (error) {
      throw uniqueViolation(error, { user_id: 'EMPLOYEE_USER_LINKED' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'employee.updated', resourceType: 'employee', resourceId: employeeId, changedFields: Object.keys(patch).filter((k) => !SENSITIVE.includes(k)) });
    return presentEmployee(context)(row);
  });
}

/** Creates an employee record for each active member of the organization who has none yet. */
export async function importMembers(context) {
  const memberships = await prisma.organizationMembership.findMany({
    where: { organizationId: context.organizationId, status: 'ACTIVE', user: { accountStatus: 'ACTIVE' } },
    select: { userId: true, joinedAt: true, user: { select: { full_name: true, email: true } }, roles: { select: { roleCode: true } } },
  });
  return withTenant(context, async (tx) => {
    const linked = new Set((await tx.wfEmployee.findMany({ where: { ...org(context), userId: { not: null } }, select: { userId: true } })).map((e) => e.userId));
    const hq = (await tx.wfCompany.findFirst({ where: { ...org(context), isHeadquarters: true }, select: { id: true } }))?.id ?? null;
    const missing = memberships.filter((m) => !linked.has(m.userId));
    const role = (codes) => (codes[0] ? codes[0].split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ') : 'Staff');
    for (const m of missing) {
      await tx.wfEmployee.create({
        data: { ...org(context), userId: m.userId, name: m.user.full_name ?? m.user.email, email: m.user.email, role: role(m.roles.map((r) => r.roleCode)), hireDate: m.joinedAt ?? new Date(), companyId: hq },
      });
    }
    await recordAudit(tx, context, { action: 'employee.imported_members', resourceType: 'employee', changedFields: [String(missing.length)] });
    return { imported: missing.length };
  });
}

// ---- organization structure -----------------------------------------------------------------------
const simpleCreate = (modelOf, action) => async (context, input) => withTenant(context, async (tx) => {
  let row;
  try {
    row = await modelOf(tx).create({ data: { ...org(context), ...input } });
  } catch (error) {
    throw uniqueViolation(error, { code: 'HR_CODE_IN_USE', name: 'HR_CODE_IN_USE' }) ?? error;
  }
  await recordAudit(tx, context, { action, resourceType: action.split('.')[0], resourceId: row.id });
  return row;
});

export const createCompany = simpleCreate((tx) => tx.wfCompany, 'company.created');
export const createEmployeeType = simpleCreate((tx) => tx.wfEmployeeType, 'employee_type.created');
export const createTag = simpleCreate((tx) => tx.wfTag, 'hr_tag.created');
export const createActionType = simpleCreate((tx) => tx.wfActionType, 'action_type.created');

export async function createJobPosition(context, input) {
  return withTenant(context, async (tx) => {
    if (!await tx.wfDepartment.count({ where: { ...org(context), id: input.departmentId } })) throw new EmrError('DEPARTMENT_NOT_FOUND');
    const row = await tx.wfJobPosition.create({ data: { ...org(context), ...input } });
    await recordAudit(tx, context, { action: 'job_position.created', resourceType: 'job_position', resourceId: row.id });
    return row;
  });
}
export async function createJobRole(context, input) {
  return withTenant(context, async (tx) => {
    if (!await tx.wfJobPosition.count({ where: { ...org(context), id: input.jobPositionId } })) throw new EmrError('HR_RECORD_NOT_FOUND');
    const row = await tx.wfJobRole.create({ data: { ...org(context), ...input } });
    await recordAudit(tx, context, { action: 'job_role.created', resourceType: 'job_role', resourceId: row.id });
    return row;
  });
}

async function checkCompanies(tx, context, ids) {
  for (const id of ids ?? []) if (!await tx.wfCompany.count({ where: { ...org(context), id } })) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown branch.' });
}
async function checkEmployee(tx, context, id) {
  if (id && !await tx.wfEmployee.count({ where: { ...org(context), id } })) throw new EmrError('EMPLOYEE_NOT_FOUND');
}

export async function createDepartment(context, input) {
  return withTenant(context, async (tx) => {
    await checkCompanies(tx, context, input.companyIds);
    await checkEmployee(tx, context, input.hodId);
    await checkEmployee(tx, context, input.deputyHodId);
    let row;
    try {
      row = await tx.wfDepartment.create({
        data: { ...org(context), ...(input.id ? { id: input.id } : {}), name: input.name, code: input.code, description: input.description ?? null, companyIds: input.companyIds ?? [], parentDepartmentId: input.parentDepartmentId ?? null, hodEmployeeId: input.hodId ?? null, deputyHodEmployeeId: input.deputyHodId ?? null },
      });
    } catch (error) {
      throw uniqueViolation(error, { code: 'HR_CODE_IN_USE' }) ?? error;
    }
    const leaders = [...new Set([input.hodId, input.deputyHodId].filter(Boolean))];
    if (leaders.length) await tx.wfDepartmentMember.createMany({ data: leaders.map((employeeId) => ({ ...org(context), departmentId: row.id, employeeId })) });
    await recordAudit(tx, context, { action: 'department.created', resourceType: 'department', resourceId: row.id });
    return { id: row.id };
  });
}

export async function updateDepartment(context, departmentId, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    await checkCompanies(tx, context, patch.companyIds);
    if (patch.parentDepartmentId) {
      let cursor = patch.parentDepartmentId;
      for (let depth = 0; cursor && depth < 50; depth += 1) {
        if (cursor === departmentId) throw new EmrError('VALIDATION_FAILED', { message: 'A department cannot sit under itself.' });
        cursor = (await tx.wfDepartment.findFirst({ where: { ...org(context), id: cursor }, select: { parentDepartmentId: true } }))?.parentDepartmentId;
      }
    }
    try {
      await updateVersioned(tx.wfDepartment, { organizationId: context.organizationId, id: departmentId, expectedVersion, data: patch, notFoundCode: 'DEPARTMENT_NOT_FOUND' });
    } catch (error) {
      throw uniqueViolation(error, { code: 'HR_CODE_IN_USE' }) ?? error;
    }
    await recordAudit(tx, context, { action: 'department.updated', resourceType: 'department', resourceId: departmentId, changedFields: Object.keys(patch) });
    return { id: departmentId };
  });
}

export async function changeLeader(context, departmentId, expectedVersion, { role, employeeId, effectiveDate, reason }) {
  return withTenant(context, async (tx) => {
    const dept = await tx.wfDepartment.findFirst({ where: { ...org(context), id: departmentId } });
    if (!dept) throw new EmrError('DEPARTMENT_NOT_FOUND');
    await checkEmployee(tx, context, employeeId);
    const field = role === 'hod' ? 'hodEmployeeId' : 'deputyHodEmployeeId';
    if ((dept[field] ?? null) === (employeeId ?? null)) throw new EmrError('INVALID_STATE', { message: 'That person already holds this role.' });
    await updateVersioned(tx.wfDepartment, { organizationId: context.organizationId, id: departmentId, expectedVersion, data: { [field]: employeeId ?? null }, notFoundCode: 'DEPARTMENT_NOT_FOUND' });
    if (employeeId) await tx.wfDepartmentMember.createMany({ data: [{ ...org(context), departmentId, employeeId }], skipDuplicates: true });
    await tx.wfHodChange.create({ data: { ...org(context), departmentId, role, previousEmployeeId: dept[field], newEmployeeId: employeeId ?? null, effectiveDate: toDate(effectiveDate), reason: reason ?? null, changedByUserId: context.userId } });
    await recordAudit(tx, context, { action: `department.${role === 'hod' ? 'hod' : 'deputy_hod'}_changed`, resourceType: 'department', resourceId: departmentId });
    return { id: departmentId };
  });
}

export async function addMember(context, departmentId, { employeeId }) {
  return withTenant(context, async (tx) => {
    if (!await tx.wfDepartment.count({ where: { ...org(context), id: departmentId } })) throw new EmrError('DEPARTMENT_NOT_FOUND');
    await checkEmployee(tx, context, employeeId);
    await tx.wfDepartmentMember.createMany({ data: [{ ...org(context), departmentId, employeeId }], skipDuplicates: true });
    await recordAudit(tx, context, { action: 'department.member_added', resourceType: 'department', resourceId: departmentId });
    return { departmentId, employeeId };
  });
}
/** Removing someone also clears any leadership role they held in that department (logged). */
export async function removeMember(context, departmentId, { employeeId }) {
  return withTenant(context, async (tx) => {
    const dept = await tx.wfDepartment.findFirst({ where: { ...org(context), id: departmentId } });
    if (!dept) throw new EmrError('DEPARTMENT_NOT_FOUND');
    await tx.wfDepartmentMember.deleteMany({ where: { ...org(context), departmentId, employeeId } });
    for (const [field, role] of [['hodEmployeeId', 'hod'], ['deputyHodEmployeeId', 'deputy-hod']]) {
      if (dept[field] === employeeId) {
        await tx.wfDepartment.updateMany({ where: { ...org(context), id: departmentId }, data: { [field]: null, version: { increment: 1 } } });
        await tx.wfHodChange.create({ data: { ...org(context), departmentId, role, previousEmployeeId: employeeId, newEmployeeId: null, effectiveDate: toDate(new Date().toISOString().slice(0, 10)), reason: 'Removed from department', changedByUserId: context.userId } });
      }
    }
    await recordAudit(tx, context, { action: 'department.member_removed', resourceType: 'department', resourceId: departmentId });
    return { departmentId, employeeId };
  });
}

// ---- documents and records ------------------------------------------------------------------------
export async function requestDocuments(context, { ids, employeeIds, title, category, notifyBeforeDays }) {
  if (ids && ids.length !== employeeIds.length) throw new EmrError('VALIDATION_FAILED', { message: 'Give one id per employee.' });
  return withTenant(context, async (tx) => {
    for (const id of employeeIds) await checkEmployee(tx, context, id);
    await tx.wfEmployeeDocument.createMany({ data: employeeIds.map((employeeId, i) => ({ ...org(context), ...(ids ? { id: ids[i] } : {}), employeeId, title, category, notifyBeforeDays, requestedByUserId: context.userId })) });
    await recordAudit(tx, context, { action: 'employee_document.requested', resourceType: 'employee_document', changedFields: [title] });
    return { requested: employeeIds.length };
  });
}
export async function uploadDocument(context, documentId, expectedVersion, { issueDate, expiryDate }) {
  if (issueDate && expiryDate && expiryDate < issueDate) throw new EmrError('VALIDATION_FAILED', { message: 'The expiry date must be after the issue date.' });
  return withTenant(context, async (tx) => {
    const doc = await tx.wfEmployeeDocument.findFirst({ where: { ...org(context), id: documentId } });
    if (!doc) throw new EmrError('HR_RECORD_NOT_FOUND');
    if (!['Requested', 'Rejected'].includes(doc.status)) throw new EmrError('INVALID_STATE', { message: 'This document is already uploaded.' });
    await updateVersioned(tx.wfEmployeeDocument, { organizationId: context.organizationId, id: documentId, expectedVersion, data: { status: 'Uploaded', issueDate: toDate(issueDate), expiryDate: toDate(expiryDate), rejectReason: null }, notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await recordAudit(tx, context, { action: 'employee_document.uploaded', resourceType: 'employee_document', resourceId: documentId });
    return { id: documentId, status: 'Uploaded' };
  });
}
export async function reviewDocument(context, documentId, expectedVersion, { status, rejectReason }) {
  return withTenant(context, async (tx) => {
    const doc = await tx.wfEmployeeDocument.findFirst({ where: { ...org(context), id: documentId } });
    if (!doc) throw new EmrError('HR_RECORD_NOT_FOUND');
    if (doc.status !== 'Uploaded') throw new EmrError('INVALID_STATE', { message: 'Only an uploaded document can be reviewed.' });
    await updateVersioned(tx.wfEmployeeDocument, {
      organizationId: context.organizationId, id: documentId, expectedVersion, notFoundCode: 'HR_RECORD_NOT_FOUND',
      data: { status, rejectReason: status === 'Rejected' ? rejectReason : null, reviewedByUserId: context.userId, reviewedAt: new Date() },
    });
    await recordAudit(tx, context, { action: `employee_document.${status.toLowerCase()}`, resourceType: 'employee_document', resourceId: documentId });
    return { id: documentId, status };
  });
}

export async function recordDisciplinary(context, input) {
  return withTenant(context, async (tx) => {
    for (const id of input.employeeIds) await checkEmployee(tx, context, id);
    if (!await tx.wfActionType.count({ where: { ...org(context), id: input.actionTypeId } })) throw new EmrError('VALIDATION_FAILED', { message: 'Unknown action type.' });
    const row = await tx.wfDisciplinaryAction.create({ data: { ...org(context), ...input, startDate: toDate(input.startDate), recordedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'disciplinary.recorded', resourceType: 'disciplinary_action', resourceId: row.id });
    return { id: row.id };
  });
}
const appendFor = (modelOf, action, build) => async (context, employeeId, input) => withTenant(context, async (tx) => {
  await checkEmployee(tx, context, employeeId);
  const row = await modelOf(tx).create({ data: { ...org(context), employeeId, ...build(input, context) } });
  await recordAudit(tx, context, { action, resourceType: 'employee', resourceId: employeeId });
  return { id: row.id };
});
export const addNote = appendFor((tx) => tx.wfEmployeeNote, 'employee.note_added', ({ note }, context) => ({ note, byUserId: context.userId }));
export const adjustBonus = appendFor((tx) => tx.wfBonusEntry, 'employee.bonus_adjusted', ({ delta, reason }, context) => ({ delta, reason, byUserId: context.userId }));
export const addQualification = appendFor((tx) => tx.wfQualification, 'employee.qualification_added', ({ title, issuingBody, dateObtained, certificateRef }, context) => ({ title, issuingBody, dateObtained: toDate(dateObtained), certificateRef: certificateRef ?? null, recordedByUserId: context.userId }));

export async function publishPolicy(context, input) {
  return withTenant(context, async (tx) => {
    const row = await tx.wfPolicy.create({ data: { ...org(context), ...input, publishedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'policy.published', resourceType: 'policy', resourceId: row.id });
    return { id: row.id };
  });
}
