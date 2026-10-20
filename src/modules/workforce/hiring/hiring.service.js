// Hiring and exits: recruitment, the talent pool, vacancy requests, onboarding and offboarding.
//
// Who does what (enforced here):
//   - HR (hr.read) sees recruitment, the talent pool, onboarding and offboarding; hr.manage changes them;
//   - a vacancy request is raised by HR or by the department's HOD/deputy, and approved through the
//     organization's "vacancy" workflow; the raiser and HR see it;
//   - onboarding is a fixed checklist; at final sign-off HR submits it to the "onboarding" workflow and
//     only an approved review lets the candidate be converted — which creates the employee record, with
//     the onboarding documents on file and the approved basic salary as their salary structure;
//   - offboarding walks a fixed exit pipeline; each stage needs its record; archiving deactivates the
//     employee.
// Documents are recorded by name and type — no files are stored here.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';
import { cancelForReference, instanceForReference, registerTrigger, rejectionComment } from '../workflows/workflows.service.js';

const org = (context) => ({ organizationId: context.organizationId });
const can = (context, permission) => context.permissions.includes(permission);
const requireManage = (context) => { if (!can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED'); };
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : undefined);
const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const num = (v) => (v === null || v === undefined ? undefined : Number(v));
const notFound = () => new EmrError('HR_RECORD_NOT_FOUND');
const audited = (tx, context, action, resourceType, resourceId, changedFields = []) => recordAudit(tx, context, { action, resourceType, resourceId, changedFields });

// The fixed checklists (same ids as the screens).
export const ONBOARDING_STAGES = [
  { id: 'ob-st0', title: 'Documentation', sequence: 0, isFinal: false },
  { id: 'ob-st1', title: 'Compliance & Training', sequence: 1, isFinal: false },
  { id: 'ob-st2', title: 'Systems & Access', sequence: 2, isFinal: false },
  { id: 'ob-st3', title: 'Final Sign-off', sequence: 3, isFinal: true },
];
export const ONBOARDING_TASKS = [
  { id: 'ob-t0', stageId: 'ob-st0', title: 'ID verification (NIN/passport)', isRequired: true, requiresUpload: true },
  { id: 'ob-t1', stageId: 'ob-st0', title: 'Signed offer letter on file', isRequired: true, requiresUpload: true },
  { id: 'ob-t2', stageId: 'ob-st0', title: 'Bank details submitted', isRequired: true },
  { id: 'ob-t3', stageId: 'ob-st1', title: 'NDPR / patient-confidentiality agreement signed', isRequired: true },
  { id: 'ob-t4', stageId: 'ob-st1', title: 'Infection prevention & control orientation', isRequired: true },
  { id: 'ob-t5', stageId: 'ob-st1', title: 'BLS / CPR briefing', isRequired: false },
  { id: 'ob-t6', stageId: 'ob-st2', title: 'EMR account provisioned', isRequired: true },
  { id: 'ob-t7', stageId: 'ob-st2', title: 'Uniform & ID badge issued', isRequired: false },
  { id: 'ob-t8', stageId: 'ob-st3', title: 'Probation terms briefed (90 days)', isRequired: true },
  { id: 'ob-t9', stageId: 'ob-st3', title: 'Introduced to reporting manager & team', isRequired: true },
];
export const OFFBOARDING_STAGES = [
  { id: 'ofb-st0', title: 'Notice Period', type: 'Notice Period', sequence: 0, isFinal: false },
  { id: 'ofb-st1', title: 'Exit Interview', type: 'Exit Interview', sequence: 1, isFinal: false },
  { id: 'ofb-st2', title: 'Work Handover', type: 'Work Handover', sequence: 2, isFinal: false },
  { id: 'ofb-st3', title: 'FNF Settlement', type: 'FNF Settlement', sequence: 3, isFinal: false },
  { id: 'ofb-st4', title: 'Farewell', type: 'Farewell', sequence: 4, isFinal: false },
  { id: 'ofb-st5', title: 'Archived', type: 'Archived', sequence: 5, isFinal: true },
];
const PIPELINE = [['Applied', 'Applied'], ['Screening', 'Test'], ['Interview', 'Interview'], ['Hired', 'Hired']];
const offerTemplate = (organisation) => `${organisation}
{{company_address}}

{{date}}

Dear {{candidate_name}},

OFFER OF EMPLOYMENT — {{job_position}}

We are pleased to offer you the position of {{job_position}} in the {{department}} department of ${organisation}, reporting to {{reporting_manager}}.

Basic salary: {{basic_salary}} per month, subject to statutory deductions.
Resumption date: {{resumption_date}}
Probation period: 90 days from resumption.

Please sign and return a copy of this letter to confirm your acceptance.

Yours sincerely,
Human Resources
${organisation}`;

async function me(tx, context) {
  return tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true, name: true } });
}
async function employeeExists(tx, context, id, { active = false } = {}) {
  if (!id) return;
  const e = await tx.wfEmployee.findFirst({ where: { ...org(context), id }, select: { status: true, name: true } });
  if (!e) throw new EmrError('EMPLOYEE_NOT_FOUND');
  if (active && e.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${e.name} is not an active employee.` });
}
async function placement(tx, context, { departmentId, jobPositionId }) {
  if (departmentId && !(await tx.wfDepartment.findFirst({ where: { ...org(context), id: departmentId }, select: { id: true } }))) throw new EmrError('DEPARTMENT_NOT_FOUND');
  if (jobPositionId && !(await tx.wfJobPosition.findFirst({ where: { ...org(context), id: jobPositionId }, select: { id: true } }))) throw notFound();
}

// ---- reading ----------------------------------------------------------------------------------------
/** Departments the caller heads (HOD or deputy) — they may raise vacancies for them. */
async function ledDepartments(tx, context, self) {
  if (!self) return [];
  const rows = await tx.wfDepartment.findMany({ where: { ...org(context), OR: [{ hodEmployeeId: self.id }, { deputyHodEmployeeId: self.id }] }, select: { id: true } });
  return rows.map((d) => d.id);
}

export async function overview(context) {
  return withTenant(context, async (tx) => {
    const self = await me(tx, context);
    const hr = can(context, 'hr.read');
    const led = await ledDepartments(tx, context, self);
    const vacancies = await tx.wfVacancy.findMany({
      where: { ...org(context), ...(hr ? {} : { OR: [{ raisedByUserId: context.userId }, { departmentId: { in: led } }] }) }, orderBy: { createdAt: 'desc' },
    });
    const base = { selfEmployeeId: self?.id ?? null, canManage: can(context, 'hr.manage'), ledDepartmentIds: led, vacancies: [], onboardingStages: ONBOARDING_STAGES, onboardingTasks: ONBOARDING_TASKS, offboardingStages: OFFBOARDING_STAGES };
    const names = await userNameMap(tx, vacancies.map((v) => v.raisedByUserId));
    base.vacancies = vacancies.map((v) => ({
      id: v.id, departmentId: v.departmentId, jobPositionId: v.jobPositionId ?? undefined, roleTitle: v.roleTitle, headcount: v.headcount, vacancyTypeId: v.vacancyTypeId ?? undefined,
      reason: v.reason, requirements: v.requirements ?? undefined, salaryMin: num(v.salaryMin), salaryMax: num(v.salaryMax), raisedBy: v.raisedByEmployeeId ?? names.get(v.raisedByUserId) ?? 'Former member',
      raisedByMe: v.raisedByUserId === context.userId, status: v.status, workflowRef: v.id, rejectionReason: v.rejectionReason ?? undefined, requisitionId: v.requisitionId ?? undefined,
      createdAt: v.createdAt, submittedAt: v.submittedAt ?? undefined, decidedAt: v.decidedAt ?? undefined, version: v.version,
    }));
    if (!hr) return { ...base, requisitions: [], stages: [], candidates: [], interviews: [], talentPool: [], onboarding: [], onboardingDocuments: [], offboarding: [], offerLetterTemplate: null };

    const [requisitions, stages, candidates, interviews, talent, entries, onboarding, documents, settings, offboarding] = await Promise.all([
      tx.wfRequisition.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.wfPipelineStage.findMany({ where: org(context), orderBy: { sequence: 'asc' } }),
      tx.wfCandidate.findMany({ where: org(context), orderBy: { appliedAt: 'desc' } }),
      tx.wfInterview.findMany({ where: org(context), orderBy: { scheduledAt: 'desc' } }),
      tx.wfTalentPool.findMany({ where: org(context), orderBy: { addedAt: 'desc' } }),
      tx.wfTalentEntry.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
      tx.wfOnboarding.findMany({ where: org(context), orderBy: { startedAt: 'desc' } }),
      tx.wfOnboardingDocument.findMany({ where: org(context), orderBy: { uploadedAt: 'desc' } }),
      tx.wfHrSettings.findUnique({ where: { organizationId: context.organizationId } }),
      tx.wfOffboarding.findMany({ where: org(context), orderBy: { createdAt: 'desc' } }),
    ]);
    const employeesByUser = new Map((await tx.wfEmployee.findMany({ where: { ...org(context), userId: { not: null } }, select: { id: true, userId: true } })).map((e) => [e.userId, e.id]));
    const entryNames = await userNameMap(tx, entries.map((e) => e.byUserId));
    const by = (userId) => employeesByUser.get(userId) ?? entryNames.get(userId) ?? 'Former member';
    // Until HR saves its own, the offer letter starts from the standard text under the hospital's name.
    const organisation = settings ? null : (await tx.wfCompany.findFirst({ where: { ...org(context), isHeadquarters: true }, select: { name: true } }))?.name;
    return {
      ...base,
      requisitions: requisitions.map((r) => ({ id: r.id, title: r.title, description: r.description, departmentId: r.departmentId ?? '', jobPositionId: r.jobPositionId ?? '', vacancy: r.vacancy, managerIds: r.managerIds, startDate: isoDay(r.startDate), endDate: isoDay(r.endDate), closed: r.closed })),
      stages: stages.map((s) => ({ id: s.id, requisitionId: s.requisitionId, name: s.name, type: s.type, sequence: s.sequence })),
      candidates: candidates.map((c) => ({
        id: c.id, requisitionId: c.requisitionId, stageId: c.stageId, name: c.name, email: c.email, phone: c.phone, source: c.source, referredBy: c.referredByEmployeeId ?? undefined,
        appliedAt: c.appliedAt, rating: c.rating, hired: c.hired, canceled: c.canceled, cancelReason: c.cancelReason ?? undefined, convertedEmployeeId: c.convertedEmployeeId ?? undefined,
      })),
      interviews: interviews.map((i) => ({ id: i.id, candidateId: i.candidateId, scheduledAt: i.scheduledAt, interviewerIds: i.interviewerIds, notes: i.notes ?? undefined, status: i.status, feedback: i.feedback ?? undefined })),
      talentPool: talent.map((t) => {
        const mine = entries.filter((e) => e.talentId === t.id);
        return {
          id: t.id, skillZone: t.skillZone, candidateName: t.candidateName, email: t.email, phone: t.phone, reason: t.reason, addedAt: t.addedAt, fromCandidateId: t.fromCandidateId ?? undefined, ...t.profile,
          notes: mine.filter((e) => e.kind === 'note').map((e) => ({ id: e.id, text: e.text, by: by(e.byUserId), at: e.createdAt })),
          documents: mine.filter((e) => e.kind === 'document').map((e) => ({ id: e.id, filename: e.text, type: e.detail ?? 'Document', sizeKb: e.sizeKb ?? 0, uploadedAt: e.createdAt })),
          history: mine.filter((e) => e.kind === 'history').map((e) => ({ id: e.id, event: e.text, detail: e.detail ?? undefined, at: e.createdAt })),
          takenToRecruitment: t.takenCandidateId ? { requisitionId: t.takenRequisitionId, candidateId: t.takenCandidateId, statusCode: t.takenStatusCode, at: t.takenAt } : undefined,
        };
      }),
      onboarding: onboarding.map((p) => ({
        id: p.id, candidateId: p.candidateId, candidateName: p.candidateName, requisitionId: p.requisitionId, jobPositionId: p.jobPositionId ?? '', departmentId: p.departmentId ?? '',
        currentStageId: p.currentStageId, taskDone: p.taskDone, startedAt: p.startedAt, completedAt: p.completedAt ?? undefined, employeeId: p.employeeId ?? undefined,
        resumptionDate: isoDay(p.resumptionDate), basicSalary: num(p.basicSalary), version: p.version,
      })),
      onboardingDocuments: documents.map((d) => ({ id: d.id, progressId: d.onboardingId, taskId: d.taskId, title: d.title, uploadedAt: d.uploadedAt })),
      offerLetterTemplate: { text: settings?.offerLetterTemplate ?? offerTemplate(organisation ?? 'Our hospital'), version: settings?.version ?? 0 },
      offboarding: offboarding.map((c) => ({
        id: c.id, employeeId: c.employeeId, reason: c.reason, noticeDate: c.noticeDate, lastWorkingDate: isoDay(c.lastWorkingDate), currentStageId: c.currentStageId, status: c.status,
        exitInterviewNotes: c.exitInterviewNotes ?? undefined, handoverNotes: c.handoverNotes ?? undefined, fnfAmount: num(c.fnfAmount), fnfSettled: c.fnfSettled, createdAt: c.createdAt, completedAt: c.completedAt ?? undefined,
      })),
    };
  });
}

// ---- recruitment ------------------------------------------------------------------------------------
export async function addRequisition(context, input) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    await placement(tx, context, input);
    for (const id of input.managerIds ?? []) await employeeExists(tx, context, id);
    let r;
    try {
      r = await tx.wfRequisition.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), title: input.title, description: input.description ?? '', departmentId: input.departmentId ?? null, jobPositionId: input.jobPositionId ?? null,
          vacancy: input.vacancy, managerIds: input.managerIds ?? [], startDate: toDate(input.startDate), endDate: toDate(input.endDate), createdByUserId: context.userId,
        },
      });
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await tx.wfPipelineStage.createMany({ data: PIPELINE.map(([name, type], sequence) => ({ ...org(context), requisitionId: r.id, name, type, sequence })) });
    await audited(tx, context, 'requisition.opened', 'requisition', r.id);
    return { id: r.id };
  });
}
export async function closeRequisition(context, id) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const { count } = await tx.wfRequisition.updateMany({ where: { ...org(context), id, closed: false }, data: { closed: true, version: { increment: 1 } } });
    if (!count) throw (await tx.wfRequisition.findFirst({ where: { ...org(context), id } })) ? new EmrError('INVALID_STATE', { message: 'This requisition is already closed.' }) : notFound();
    await audited(tx, context, 'requisition.closed', 'requisition', id);
    return { id, closed: true };
  });
}
async function openRequisition(tx, context, id) {
  const r = await tx.wfRequisition.findFirst({ where: { ...org(context), id } });
  if (!r) throw notFound();
  if (r.closed) throw new EmrError('INVALID_STATE', { message: 'This requisition is closed.' });
  return r;
}
const stagesOf = (tx, context, requisitionId) => tx.wfPipelineStage.findMany({ where: { ...org(context), requisitionId }, orderBy: { sequence: 'asc' } });

export async function addCandidate(context, input) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    await openRequisition(tx, context, input.requisitionId);
    await employeeExists(tx, context, input.referredBy);
    const [first] = await stagesOf(tx, context, input.requisitionId);
    let c;
    try {
      c = await tx.wfCandidate.create({
        data: {
          ...(input.id ? { id: input.id } : {}), ...org(context), requisitionId: input.requisitionId, stageId: first.id, name: input.name, email: input.email, phone: input.phone ?? '',
          source: input.source, referredByEmployeeId: input.source === 'Referral' ? input.referredBy ?? null : null,
        },
      });
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'candidate.added', 'candidate', c.id);
    return { id: c.id };
  });
}
async function candidate(tx, context, id) {
  const c = await tx.wfCandidate.findFirst({ where: { ...org(context), id } });
  if (!c) throw notFound();
  return c;
}
async function changeCandidate(tx, context, c, data, action) {
  await updateVersioned(tx.wfCandidate, { organizationId: context.organizationId, id: c.id, expectedVersion: c.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  await audited(tx, context, action, 'candidate', c.id, Object.keys(data));
  return { id: c.id };
}
export async function moveCandidate(context, id, { stageId }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, id);
    if (c.canceled || c.hired) throw new EmrError('INVALID_STATE', { message: 'A rejected or hired candidate cannot move stage.' });
    if (!(await tx.wfPipelineStage.findFirst({ where: { ...org(context), id: stageId, requisitionId: c.requisitionId } }))) throw notFound();
    return changeCandidate(tx, context, c, { stageId }, 'candidate.moved');
  });
}
export async function rateCandidate(context, id, { rating }) {
  requireManage(context);
  return withTenant(context, async (tx) => changeCandidate(tx, context, await candidate(tx, context, id), { rating }, 'candidate.rated'));
}
export async function rejectCandidate(context, id, { reason }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, id);
    if (c.canceled || c.hired) throw new EmrError('INVALID_STATE', { message: 'This candidate has already been rejected or hired.' });
    return changeCandidate(tx, context, c, { canceled: true, cancelReason: reason }, 'candidate.rejected');
  });
}
export async function hireCandidate(context, id) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, id);
    if (c.canceled || c.hired) throw new EmrError('INVALID_STATE', { message: 'This candidate has already been rejected or hired.' });
    const hired = (await stagesOf(tx, context, c.requisitionId)).find((s) => s.type === 'Hired');
    return changeCandidate(tx, context, c, { hired: true, ...(hired ? { stageId: hired.id } : {}) }, 'candidate.hired');
  });
}
export async function scheduleInterview(context, input) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, input.candidateId);
    if (c.canceled) throw new EmrError('INVALID_STATE', { message: 'This candidate has been rejected.' });
    for (const id of input.interviewerIds) await employeeExists(tx, context, id, { active: true });
    const i = await tx.wfInterview.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), candidateId: c.id, scheduledAt: new Date(input.scheduledAt), interviewerIds: input.interviewerIds, notes: input.notes ?? null, createdByUserId: context.userId } });
    await audited(tx, context, 'interview.scheduled', 'interview', i.id);
    return { id: i.id };
  });
}
export async function completeInterview(context, id, { feedback }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const { count } = await tx.wfInterview.updateMany({ where: { ...org(context), id, status: 'Scheduled' }, data: { status: 'Completed', feedback, version: { increment: 1 } } });
    if (!count) throw (await tx.wfInterview.findFirst({ where: { ...org(context), id } })) ? new EmrError('INVALID_STATE', { message: 'This interview has already been recorded.' }) : notFound();
    await audited(tx, context, 'interview.completed', 'interview', id);
    return { id, status: 'Completed' };
  });
}

// ---- talent pool ------------------------------------------------------------------------------------
const history = (tx, context, talentId, text, detail) => tx.wfTalentEntry.create({ data: { ...org(context), talentId, kind: 'history', text, detail: detail ?? null, byUserId: context.userId } });
export async function addToTalentPool(context, { id, candidateId, skillZone, reason }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, candidateId);
    let t;
    try {
      t = await tx.wfTalentPool.create({ data: { ...(id ? { id } : {}), ...org(context), skillZone, candidateName: c.name, email: c.email, phone: c.phone, reason, fromCandidateId: c.id, addedByUserId: context.userId } });
    } catch (error) { throw uniqueViolation(error, { from_candidate: 'HR_CODE_IN_USE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await history(tx, context, t.id, 'Added to talent pool', skillZone);
    await audited(tx, context, 'talent.added', 'talent', t.id);
    return { id: t.id };
  });
}
async function talentEntry(tx, context, id) {
  const t = await tx.wfTalentPool.findFirst({ where: { ...org(context), id } });
  if (!t) throw notFound();
  return t;
}
export async function addTalentNote(context, id, { text }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    await talentEntry(tx, context, id);
    const e = await tx.wfTalentEntry.create({ data: { ...org(context), talentId: id, kind: 'note', text, byUserId: context.userId } });
    await audited(tx, context, 'talent.note_added', 'talent', id);
    return { id: e.id };
  });
}
export async function addTalentDocument(context, id, { type, filename, sizeKb }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    await talentEntry(tx, context, id);
    const e = await tx.wfTalentEntry.create({ data: { ...org(context), talentId: id, kind: 'document', text: filename, detail: type, sizeKb: sizeKb ?? null, byUserId: context.userId } });
    await audited(tx, context, 'talent.document_added', 'talent', id);
    return { id: e.id };
  });
}
/** Moves a talent-pool applicant into an open requisition at the stage named by a recruitment status. */
export async function takeToRecruitment(context, id, { requisitionId, statusCode, statusLabel, stageType, candidateId }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const t = await talentEntry(tx, context, id);
    if (t.takenCandidateId) throw new EmrError('INVALID_STATE', { message: 'This applicant is already in recruitment.' });
    const r = await openRequisition(tx, context, requisitionId);
    const stages = await stagesOf(tx, context, requisitionId);
    let stage = stages.find((s) => s.name.toLowerCase() === statusLabel.toLowerCase());
    if (!stage) stage = await tx.wfPipelineStage.create({ data: { ...org(context), requisitionId, name: statusLabel, type: stageType, sequence: Math.max(-1, ...stages.map((s) => s.sequence)) + 1 } });
    const c = await tx.wfCandidate.create({
      data: { ...(candidateId ? { id: candidateId } : {}), ...org(context), requisitionId, stageId: stage.id, name: t.candidateName, email: t.email || '-', phone: t.phone, source: 'Inside software', hired: stage.type === 'Hired' },
    });
    await tx.wfTalentPool.updateMany({ where: { ...org(context), id }, data: { takenRequisitionId: requisitionId, takenCandidateId: c.id, takenStatusCode: statusCode, takenAt: new Date() } });
    await history(tx, context, id, 'Moved to recruitment', `${r.title} — ${statusLabel}`);
    await audited(tx, context, 'talent.moved_to_recruitment', 'talent', id);
    return { ok: true, candidateId: c.id };
  });
}

// ---- vacancy requests -------------------------------------------------------------------------------
async function vacancy(tx, context, id) {
  const v = await tx.wfVacancy.findFirst({ where: { ...org(context), id } });
  if (!v) throw notFound();
  return v;
}
async function mayRaise(tx, context, departmentId) {
  if (can(context, 'hr.manage')) return;
  const led = await ledDepartments(tx, context, await me(tx, context));
  if (!led.includes(departmentId)) throw new EmrError('PERMISSION_DENIED', { message: 'Only HR or the department\'s head can raise a vacancy for it.' });
}
const vacancyData = (input) => Object.fromEntries(Object.entries({
  departmentId: input.departmentId, jobPositionId: input.jobPositionId, roleTitle: input.roleTitle, headcount: input.headcount, vacancyTypeId: input.vacancyTypeId,
  reason: input.reason, requirements: input.requirements, salaryMin: input.salaryMin, salaryMax: input.salaryMax,
}).filter(([, v]) => v !== undefined));

export async function createVacancy(context, input) {
  return withTenant(context, async (tx) => {
    await mayRaise(tx, context, input.departmentId);
    await placement(tx, context, input);
    const self = await me(tx, context);
    let v;
    try {
      v = await tx.wfVacancy.create({ data: { ...(input.id ? { id: input.id } : {}), ...org(context), ...vacancyData(input), raisedByUserId: context.userId, raisedByEmployeeId: self?.id ?? null } });
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'vacancy.drafted', 'vacancy', v.id);
    return { id: v.id };
  });
}
const ownsVacancy = (context, v) => v.raisedByUserId === context.userId || can(context, 'hr.manage');
export async function updateVacancy(context, id, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    const v = await vacancy(tx, context, id);
    if (!ownsVacancy(context, v)) throw new EmrError('PERMISSION_DENIED');
    if (!['Draft', 'Rejected'].includes(v.status)) throw new EmrError('INVALID_STATE', { message: 'Only a draft or rejected request can be edited.' });
    if (patch.departmentId) await mayRaise(tx, context, patch.departmentId);
    await placement(tx, context, patch);
    await updateVersioned(tx.wfVacancy, { organizationId: context.organizationId, id, expectedVersion, data: vacancyData(patch), notFoundCode: 'HR_RECORD_NOT_FOUND' });
    await audited(tx, context, 'vacancy.updated', 'vacancy', id, Object.keys(vacancyData(patch)));
    return { id };
  });
}
export async function cancelVacancy(context, id) {
  return withTenant(context, async (tx) => {
    const v = await vacancy(tx, context, id);
    if (!ownsVacancy(context, v)) throw new EmrError('PERMISSION_DENIED');
    if (['Cancelled', 'Filled'].includes(v.status)) throw new EmrError('INVALID_STATE', { message: 'This request is already closed.' });
    await cancelForReference(tx, context, 'vacancy', id, 'vacancy withdrawn');
    await tx.wfVacancy.updateMany({ where: { ...org(context), id }, data: { status: 'Cancelled', version: { increment: 1 } } });
    await audited(tx, context, 'vacancy.cancelled', 'vacancy', id);
    return { id, status: 'Cancelled' };
  });
}
export async function markVacancyFilled(context, id) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const { count } = await tx.wfVacancy.updateMany({ where: { ...org(context), id, status: 'Approved' }, data: { status: 'Filled', version: { increment: 1 } } });
    if (!count) throw new EmrError('INVALID_STATE', { message: 'Only an approved request can be marked filled.' });
    await audited(tx, context, 'vacancy.filled', 'vacancy', id);
    return { id, status: 'Filled' };
  });
}
registerTrigger('vacancy', {
  async load(tx, context, reference) {
    const v = await vacancy(tx, context, reference);
    if (v.raisedByUserId !== context.userId && !can(context, 'hr.manage')) throw new EmrError('PERMISSION_DENIED');
    if (!['Draft', 'Rejected'].includes(v.status)) throw new EmrError('INVALID_STATE', { message: 'Only a draft or rejected request can be submitted.' });
    const dept = await tx.wfDepartment.findFirst({ where: { ...org(context), id: v.departmentId }, select: { name: true } });
    return { subject: `Vacancy: ${v.headcount}× ${v.roleTitle} (${dept?.name ?? 'department'})`, departmentId: v.departmentId, facts: { headcount: v.headcount, salaryMax: num(v.salaryMax) ?? 0, salaryMin: num(v.salaryMin) ?? 0 } };
  },
  async started(tx, context, instance) {
    const data = { submittedAt: new Date(), ...(instance.status === 'Running' ? { status: 'Submitted', rejectionReason: null, decidedAt: null } : {}) };
    await tx.wfVacancy.updateMany({ where: { ...org(context), id: instance.reference }, data: { ...data, version: { increment: 1 } } });
    await audited(tx, context, 'vacancy.submitted', 'vacancy', instance.reference);
  },
  async complete(tx, context, instance, outcome) {
    if (outcome === 'cancelled') return;
    const reason = outcome === 'rejected' ? (await rejectionComment(tx, context, instance.id)) || 'Rejected — no reason given' : null;
    await tx.wfVacancy.updateMany({
      where: { ...org(context), id: instance.reference },
      data: { status: outcome === 'approved' ? 'Approved' : 'Rejected', rejectionReason: reason, decidedAt: new Date(), version: { increment: 1 } },
    });
  },
});

// ---- onboarding -------------------------------------------------------------------------------------
async function progress(tx, context, id) {
  const p = await tx.wfOnboarding.findFirst({ where: { ...org(context), id } });
  if (!p) throw notFound();
  return p;
}
const stageOf = (p) => ONBOARDING_STAGES.find((s) => s.id === p.currentStageId);
const stageReady = (p) => ONBOARDING_TASKS.filter((t) => t.stageId === p.currentStageId && t.isRequired).every((t) => p.taskDone[t.id]);
const changeProgress = async (tx, context, p, data, action) => {
  await updateVersioned(tx.wfOnboarding, { organizationId: context.organizationId, id: p.id, expectedVersion: p.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  await audited(tx, context, action, 'onboarding', p.id, Object.keys(data));
  return { id: p.id };
};
const openProgress = (p) => { if (p.employeeId) throw new EmrError('INVALID_STATE', { message: 'This new hire has already been converted to an employee.' }); };

export async function startOnboarding(context, { id, candidateId }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await candidate(tx, context, candidateId);
    if (!c.hired) throw new EmrError('INVALID_STATE', { message: 'Only a hired candidate can start onboarding.' });
    if (await tx.wfOnboarding.findFirst({ where: { ...org(context), candidateId }, select: { id: true } })) throw new EmrError('INVALID_STATE', { message: 'Onboarding has already started for this candidate.' });
    const r = await tx.wfRequisition.findFirst({ where: { ...org(context), id: c.requisitionId } });
    let p;
    try {
      p = await tx.wfOnboarding.create({
        data: { ...(id ? { id } : {}), ...org(context), candidateId: c.id, candidateName: c.name, requisitionId: r.id, jobPositionId: r.jobPositionId, departmentId: r.departmentId, currentStageId: ONBOARDING_STAGES[0].id, startedByUserId: context.userId },
      });
    } catch (error) { throw uniqueViolation(error, { candidate: 'INVALID_STATE', pkey: 'HR_CODE_IN_USE' }) ?? error; }
    await audited(tx, context, 'onboarding.started', 'onboarding', p.id);
    return { id: p.id };
  });
}
export async function toggleTask(context, id, { taskId }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const p = await progress(tx, context, id);
    openProgress(p);
    const task = ONBOARDING_TASKS.find((t) => t.id === taskId);
    if (!task || task.stageId !== p.currentStageId) throw new EmrError('INVALID_STATE', { message: 'That task is not part of the current stage.' });
    if (task.requiresUpload) throw new EmrError('INVALID_STATE', { message: 'This task is completed by recording its document.' });
    return changeProgress(tx, context, p, { taskDone: { ...p.taskDone, [taskId]: !p.taskDone[taskId] } }, 'onboarding.task_toggled');
  });
}
export async function uploadTaskDocument(context, id, { taskId, title }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const p = await progress(tx, context, id);
    openProgress(p);
    const task = ONBOARDING_TASKS.find((t) => t.id === taskId);
    if (!task?.requiresUpload) throw new EmrError('INVALID_STATE', { message: 'That task does not take a document.' });
    await tx.wfOnboardingDocument.create({ data: { ...org(context), onboardingId: id, taskId, title, uploadedByUserId: context.userId } });
    return changeProgress(tx, context, p, { taskDone: { ...p.taskDone, [taskId]: true } }, 'onboarding.document_recorded');
  });
}
export async function updateOnboarding(context, id, { resumptionDate, basicSalary }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const p = await progress(tx, context, id);
    openProgress(p);
    if (!stageOf(p)?.isFinal) throw new EmrError('INVALID_STATE', { message: 'Resumption date and salary are set at final sign-off.' });
    const running = await instanceForReference(tx, context, 'onboarding', id);
    if (running?.status === 'Running' || running?.status === 'Approved') throw new EmrError('INVALID_STATE', { message: 'This new hire is with HR for review; it cannot change now.' });
    return changeProgress(tx, context, p, Object.fromEntries(Object.entries({ resumptionDate: resumptionDate === undefined ? undefined : toDate(resumptionDate), basicSalary }).filter(([, v]) => v !== undefined)), 'onboarding.terms_set');
  });
}
export async function advanceOnboarding(context, id) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const p = await progress(tx, context, id);
    openProgress(p);
    const stage = stageOf(p);
    if (stage.isFinal) throw new EmrError('INVALID_STATE', { message: 'Final sign-off goes to HR review, then conversion.' });
    if (!stageReady(p)) throw new EmrError('INVALID_STATE', { message: 'Complete the required tasks of this stage first.' });
    return changeProgress(tx, context, p, { currentStageId: ONBOARDING_STAGES[stage.sequence + 1].id }, 'onboarding.advanced');
  });
}
registerTrigger('onboarding', {
  async load(tx, context, reference) {
    requireManage(context);
    const p = await progress(tx, context, reference);
    openProgress(p);
    if (!stageOf(p)?.isFinal || !stageReady(p)) throw new EmrError('INVALID_STATE', { message: 'Finish the checklist before HR review.' });
    if (!p.resumptionDate || !p.basicSalary) throw new EmrError('INVALID_STATE', { message: 'Set the resumption date and basic salary first.' });
    return { subject: `Convert ${p.candidateName} to employee`, departmentId: p.departmentId ?? undefined, facts: { basicSalary: Number(p.basicSalary), salary: Number(p.basicSalary) } };
  },
});
export async function convertToEmployee(context, id, { employeeId, role, cadre }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const p = await progress(tx, context, id);
    openProgress(p);
    const review = await instanceForReference(tx, context, 'onboarding', id);
    if (review?.status !== 'Approved') throw new EmrError('INVALID_STATE', { message: 'HR review must approve this new hire first.' });
    const c = await candidate(tx, context, p.candidateId);
    const hq = (await tx.wfCompany.findFirst({ where: { ...org(context), isHeadquarters: true }, select: { id: true } }))?.id ?? null;
    const joined = p.resumptionDate ?? toDate(new Date().toISOString().slice(0, 10));
    let e;
    try {
      e = await tx.wfEmployee.create({
        data: { ...(employeeId ? { id: employeeId } : {}), ...org(context), name: p.candidateName, role, cadre: cadre ?? '', email: c.email && c.email !== '-' ? c.email : null, phone: c.phone || null, hireDate: joined, dateJoining: joined, companyId: hq, departmentId: p.departmentId, jobPositionId: p.jobPositionId, status: 'ACTIVE' },
      });
    } catch (error) { throw uniqueViolation(error, { pkey: 'HR_CODE_IN_USE' }) ?? error; }
    // The basic salary HR review approved becomes the new employee's salary structure.
    if (p.basicSalary) await tx.wfSalaryStructure.create({ data: { ...org(context), employeeId: e.id, basicSalary: p.basicSalary, updatedByUserId: context.userId } });
    const docs = await tx.wfOnboardingDocument.findMany({ where: { ...org(context), onboardingId: id } });
    if (docs.length) {
      await tx.wfEmployeeDocument.createMany({
        data: docs.map((d) => ({ ...org(context), employeeId: e.id, title: d.title, category: 'Onboarding', status: 'Approved', issueDate: d.uploadedAt, requestedByUserId: d.uploadedByUserId, reviewedByUserId: context.userId, reviewedAt: new Date() })),
      });
    }
    await changeProgress(tx, context, p, { employeeId: e.id, completedAt: new Date() }, 'onboarding.converted');
    await tx.wfCandidate.updateMany({ where: { ...org(context), id: c.id }, data: { convertedEmployeeId: e.id, version: { increment: 1 } } });
    await audited(tx, context, 'employee.created', 'employee', e.id, ['onboarding']);
    return { id, employeeId: e.id };
  });
}
export async function saveOfferTemplate(context, expectedVersion, { text }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const row = await tx.wfHrSettings.findUnique({ where: { organizationId: context.organizationId } });
    if (!row) {
      if (expectedVersion !== 0) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: 0 } });
      await tx.wfHrSettings.create({ data: { ...org(context), offerLetterTemplate: text, updatedByUserId: context.userId } });
    } else {
      const { count } = await tx.wfHrSettings.updateMany({ where: { ...org(context), version: expectedVersion }, data: { offerLetterTemplate: text, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
      if (!count) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: row.version } });
    }
    await audited(tx, context, 'hr.offer_template_updated', 'hr_settings', null);
    return { saved: true };
  });
}

// ---- offboarding ------------------------------------------------------------------------------------
async function exitCase(tx, context, id) {
  const c = await tx.wfOffboarding.findFirst({ where: { ...org(context), id } });
  if (!c) throw notFound();
  if (c.status !== 'Ongoing') throw new EmrError('INVALID_STATE', { message: 'This exit is complete.' });
  return c;
}
const changeCase = async (tx, context, c, data, action) => {
  await updateVersioned(tx.wfOffboarding, { organizationId: context.organizationId, id: c.id, expectedVersion: c.version, data, notFoundCode: 'HR_RECORD_NOT_FOUND' });
  await audited(tx, context, action, 'offboarding', c.id, Object.keys(data));
  return { id: c.id };
};
export async function initiateOffboarding(context, { id, employeeId, reason, lastWorkingDate }) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    await employeeExists(tx, context, employeeId, { active: true });
    if (await tx.wfOffboarding.findFirst({ where: { ...org(context), employeeId, status: 'Ongoing' }, select: { id: true } })) throw new EmrError('INVALID_STATE', { message: 'An exit is already in progress for this employee.' });
    let c;
    try {
      c = await tx.wfOffboarding.create({ data: { ...(id ? { id } : {}), ...org(context), employeeId, reason, lastWorkingDate: toDate(lastWorkingDate), currentStageId: OFFBOARDING_STAGES[0].id, startedByUserId: context.userId } });
    } catch (error) {
      throw uniqueViolation(error, { one_ongoing: 'INVALID_STATE', pkey: 'HR_CODE_IN_USE' }) ?? error;
    }
    await audited(tx, context, 'offboarding.started', 'offboarding', c.id);
    return { id: c.id };
  });
}
export async function recordExit(context, id, input) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await exitCase(tx, context, id);
    if (input.fnfAmount !== undefined) return changeCase(tx, context, c, { fnfAmount: input.fnfAmount, fnfSettled: true }, 'offboarding.fnf_settled');
    const data = Object.fromEntries(Object.entries({ exitInterviewNotes: input.exitInterviewNotes, handoverNotes: input.handoverNotes }).filter(([, v]) => v !== undefined));
    return changeCase(tx, context, c, data, 'offboarding.recorded');
  });
}
export async function advanceOffboarding(context, id) {
  requireManage(context);
  return withTenant(context, async (tx) => {
    const c = await exitCase(tx, context, id);
    const stage = OFFBOARDING_STAGES.find((s) => s.id === c.currentStageId);
    const ready = { 'Exit Interview': !!c.exitInterviewNotes, 'Work Handover': !!c.handoverNotes, 'FNF Settlement': c.fnfSettled }[stage.type] ?? true;
    if (!ready || stage.isFinal) throw new EmrError('INVALID_STATE', { message: `Record the ${stage.title.toLowerCase()} first.` });
    const next = OFFBOARDING_STAGES[stage.sequence + 1];
    if (!next.isFinal) return changeCase(tx, context, c, { currentStageId: next.id }, 'offboarding.advanced');
    await changeCase(tx, context, c, { currentStageId: next.id, status: 'Completed', completedAt: new Date() }, 'offboarding.archived');
    await tx.wfEmployee.updateMany({ where: { ...org(context), id: c.employeeId }, data: { status: 'INACTIVE', version: { increment: 1 }, updatedAt: new Date() } });
    await audited(tx, context, 'employee.deactivated', 'employee', c.employeeId, ['offboarding']);
    return { id, status: 'Completed' };
  });
}
