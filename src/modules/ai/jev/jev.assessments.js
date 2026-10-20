import { createHash } from 'node:crypto';
import prisma from '../../../config/db.js';
import { activeMembershipFor } from '../../identity/identity.service.js';
import { approvedEmrFor, emrPatientRegistryEnabled } from '../../emr/emr.entitlement.js';
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { EmrError } from '../../emr/core/errors.js';
import { documentationQuestionSet as definition } from './jev.registry.js';
import { evaluateJev, validateJevRequest, validateJevResponse } from './jev.provider.js';

const fields = ['subjective','objective','assessment','plan','body','followUp','patientInstructions'];
const fingerprint = (note) => createHash('sha256').update(JSON.stringify([note.id,note.version,note.status,note.kind,...fields.map((f) => note[f] ?? null)])).digest('hex');
const enabled = () => process.env.JEV_ENABLED === 'true' && process.env.JEV_PROCESSING_APPROVED === 'true';
const dailyLimit = () => {
  const value = Number(process.env.JEV_DAILY_ASSESSMENT_LIMIT ?? 30);
  return Number.isInteger(value) && value > 0 && value <= 1000 ? value : 30;
};
const unavailable = () => new EmrError('JEV_UNAVAILABLE');
const noteFor = (tx, context, encounterId, noteId) => tx.emrClinicalNote.findFirst({ where: { id: noteId, encounterId, organizationId: context.organizationId } });
async function authority(context) {
  const current = await activeMembershipFor(context.userId, context.organizationId);
  if (!current.roles.includes('DOCTOR') || !current.permissions.includes('clinical.read') || !emrPatientRegistryEnabled() || !await approvedEmrFor(current)) throw new EmrError('PERMISSION_DENIED');
}
async function policyFor(tx, context) {
  if (!enabled()) throw unavailable();
  const p = await tx.emrJevPolicy.findUnique({ where: { organizationId_workflow: { organizationId: context.organizationId, workflow: definition.workflow } } });
  // No invented probability threshold: every visible finding is a professional review item.
  // Clinical-owner approval and an evaluation reference are prerequisites, not implied by a key.
  if (!p || !['SHADOW','REVIEW_ONLY'].includes(p.mode) || p.questionVersion !== definition.version || !p.clinicalOwnerUserId || !p.approvalReference?.trim() || !p.processingApprovedAt || !/^jev-\d+\.\d+\.\d+$/.test(p.model)) throw unavailable();
  return p;
}
async function ready(context) {
  const policy = await withTenant(context, (tx) => policyFor(tx, context));
  const owner = await activeMembershipFor(policy.clinicalOwnerUserId, context.organizationId);
  if (!owner.roles.includes('DOCTOR')) throw unavailable();
  return policy;
}
const visible = (row, note, policy) => ({ id: row.id, noteId: row.noteId, encounterId: row.encounterId, questionVersion: row.questionVersion, policyVersion: row.policyVersion,
  sourceRevision: row.noteVersion, requestedModel: row.requestedModel, resolvedModel: row.resolvedModel, mode: row.mode,
  processingStatus: !note || fingerprint(note) !== row.sourceFingerprint ? 'STALE' : row.processingStatus,
  // Shadow results are persisted for controlled evaluation, not displayed as clinical advice.
  answers: enabled() && policy?.mode === 'REVIEW_ONLY' && policy.version === row.policyVersion && row.mode === 'REVIEW_ONLY' && note && fingerprint(note) === row.sourceFingerprint && row.processingStatus === 'COMPLETED' ? row.answers : null,
  errorCode: row.errorCode, createdAt: row.createdAt, finishedAt: row.finishedAt, clinicalActionApplied: false,
});
export async function queueJevAssessment(context, encounterId, noteId, input) {
  await authority(context); await ready(context);
  return withTenant(context, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 2)::text`;
    await tx.$queryRaw`SELECT id FROM emr_clinical_notes WHERE organization_id=${context.organizationId} AND id=${noteId} FOR UPDATE`;
    const note = await noteFor(tx, context, encounterId, noteId); if (!note) throw new EmrError('NOTE_NOT_FOUND');
    if (note.version !== input.noteVersion) throw new EmrError('VERSION_CONFLICT');
    if (note.status !== 'DRAFT') throw new EmrError('NOTE_SIGNED');
    const policy = await policyFor(tx, context); const hash = fingerprint(note);
    // Serialize duplicate event delivery and concurrent submissions for this source.
    const previous = await tx.emrJevAssessment.findFirst({ where: { organizationId: context.organizationId, OR: [{ clientRequestId: input.clientRequestId }, { noteId, sourceFingerprint: hash, policyVersion: policy.version, questionVersion: definition.version }] } });
    if (previous) { if (previous.noteId !== noteId || previous.sourceFingerprint !== hash) throw new EmrError('IDEMPOTENCY_KEY_REUSED'); return visible(previous, note, policy); }
    const since = new Date(); since.setUTCHours(0,0,0,0);
    if (await tx.emrJevAssessment.count({ where: { organizationId: context.organizationId, createdAt: { gte: since } } }) >= dailyLimit()) throw new EmrError('RATE_LIMITED');
    const row = await tx.emrJevAssessment.create({ data: { organizationId: context.organizationId, noteId, encounterId, requestedByUserId: context.userId, clientRequestId: input.clientRequestId,
      workflow: definition.workflow, questionVersion: definition.version, sourceFingerprint: hash, noteVersion: note.version, policyVersion: policy.version, mode: policy.mode, requestedModel: policy.model } });
    await tx.jevAssessmentJob.create({ data: { organizationId: context.organizationId, assessmentId: row.id, requestedByUserId: context.userId } });
    await recordAudit(tx, context, { action: 'jev.assessment.requested', resourceType: 'jev_assessment', resourceId: row.id }); return visible(row, note, policy);
  });
}
export async function listJevAssessments(context, encounterId, noteId) {
  await authority(context);
  // Historical metadata remains readable during an outage/disable, but revoked policy
  // approval must not continue exposing its generated assessment as reviewable advice.
  let approvedPolicy;
  try { approvedPolicy = await ready(context); } catch { approvedPolicy = null; }
  return withTenant(context, async (tx) => {
    const note = await noteFor(tx, context, encounterId, noteId); if (!note) throw new EmrError('NOTE_NOT_FOUND');
    const rows = await tx.emrJevAssessment.findMany({ where: { organizationId: context.organizationId, encounterId, noteId }, orderBy: { createdAt: 'desc' }, take: 25, include: { reviews: { orderBy: { createdAt: 'desc' }, take: 10 } } });
    const policy = await tx.emrJevPolicy.findUnique({ where: { organizationId_workflow: { organizationId: context.organizationId, workflow: definition.workflow } } });
    await recordAudit(tx, context, { action: 'jev.assessment.viewed', resourceType: 'clinical_note', resourceId: noteId });
    return { available: Boolean(approvedPolicy && approvedPolicy.version === policy?.version), workflow: definition.workflow, questionVersion: definition.version,
      items: rows.map((r) => ({ ...visible(r, note, approvedPolicy?.version === policy?.version ? policy : null), reviews: r.reviews })) };
  });
}
export async function reviewJevAssessment(context, id, input) {
  await authority(context); await ready(context);
  return withTenant(context, async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(739294, 2)::text`;
    const row = await tx.emrJevAssessment.findFirst({ where: { id, organizationId: context.organizationId } }); if (!row) throw new EmrError('NOT_FOUND');
    const previous = await tx.emrJevReview.findUnique({ where: { organizationId_clientRequestId: { organizationId: context.organizationId, clientRequestId: input.clientRequestId } } });
    if (previous) { if (previous.assessmentId !== id || previous.actorUserId !== context.userId || previous.disposition !== input.disposition || previous.reason !== input.reason) throw new EmrError('IDEMPOTENCY_KEY_REUSED'); return { ...previous, clinicalActionApplied: false }; }
    await tx.$queryRaw`SELECT id FROM emr_clinical_notes WHERE organization_id=${context.organizationId} AND id=${row.noteId} FOR SHARE`;
    const note = await noteFor(tx, context, row.encounterId, row.noteId); const policy = await policyFor(tx, context);
    if (row.mode !== 'REVIEW_ONLY' || row.processingStatus !== 'COMPLETED' || !note || fingerprint(note) !== row.sourceFingerprint || policy.version !== row.policyVersion) throw new EmrError('JEV_ASSESSMENT_STALE');
    const review = await tx.emrJevReview.create({ data: { organizationId: context.organizationId, assessmentId: id, actorUserId: context.userId, clientRequestId: input.clientRequestId, disposition: input.disposition, reason: input.reason } });
    await recordAudit(tx, context, { action: 'jev.assessment.reviewed', resourceType: 'jev_assessment', resourceId: id });
    return { ...review, clinicalActionApplied: false };
  });
}
export async function processJevAssessmentQueue({ evaluate = evaluateJev } = {}) {
  // Metadata queue only. Clinical reads/writes below always enter the restricted tenant role.
  const staleJobs = await prisma.jevAssessmentJob.findMany({ where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - 120000) } }, take: 10 });
  for (const job of staleJobs) {
    await withTenant({ organizationId: job.organizationId, userId: job.requestedByUserId }, (tx) => tx.emrJevAssessment.updateMany({ where: { id: job.assessmentId, processingStatus: { in: ['QUEUED','RUNNING'] } }, data: { processingStatus: 'FAILED', errorCode: 'JEV_INTERRUPTED', finishedAt: new Date() } }));
    await prisma.jevAssessmentJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FINISHED', finishedAt: new Date() } });
  }
  const job = await prisma.jevAssessmentJob.findFirst({ where: { status: 'QUEUED' }, orderBy: { createdAt: 'asc' } }); if (!job) return false;
  const claim = await prisma.jevAssessmentJob.updateMany({ where: { id: job.id, status: 'QUEUED' }, data: { status: 'RUNNING', startedAt: new Date() } }); if (!claim.count) return false;
  const context = { organizationId: job.organizationId, userId: job.requestedByUserId };
  try {
    await authority(context); await ready(context);
    const request = await withTenant(context, async (tx) => {
      const row = await tx.emrJevAssessment.findFirst({ where: { id: job.assessmentId, organizationId: context.organizationId } });
      const policy = await policyFor(tx, context); const note = row && await noteFor(tx, context, row.encounterId, row.noteId);
      if (!row || !note || fingerprint(note) !== row.sourceFingerprint || policy.version !== row.policyVersion) throw new EmrError('JEV_ASSESSMENT_STALE');
      const state = { note: Object.fromEntries(fields.map((f) => [f, note[f] ?? null])), purpose: 'Review medicine-history documentation only; no diagnosis, prescription or medication safety conclusion.' };
      const payload = validateJevRequest({ model: row.requestedModel, state, questions: definition.questions });
      await tx.emrJevAssessment.updateMany({ where: { id: row.id, processingStatus: 'QUEUED' }, data: { processingStatus: 'RUNNING' } }); return payload;
    });
    const response = await evaluate(request);
    // Injected test providers use the same typed result shape as the live adapter.
    const checked = validateJevResponse({ model: response.model, answers: response.answers, usage: { input_tokens: response.usage.inputTokens, output_tokens: response.usage.outputTokens } }, request);
    await authority(context); await ready(context);
    await withTenant(context, async (tx) => {
      const row = await tx.emrJevAssessment.findFirst({ where: { id: job.assessmentId, organizationId: context.organizationId } });
      const policy = await policyFor(tx, context);
      await tx.$queryRaw`SELECT id FROM emr_clinical_notes WHERE organization_id=${context.organizationId} AND id=${row.noteId} FOR SHARE`;
      const note = await noteFor(tx, context, row.encounterId, row.noteId);
      if (!note || fingerprint(note) !== row.sourceFingerprint || policy.version !== row.policyVersion) throw new EmrError('JEV_ASSESSMENT_STALE');
      const changed = await tx.emrJevAssessment.updateMany({ where: { id: row.id, processingStatus: 'RUNNING' }, data: { processingStatus: 'COMPLETED', resolvedModel: checked.model, answers: checked.answers, usage: checked.usage, finishedAt: new Date() } });
      if (changed.count) await recordAudit(tx, context, { action: 'jev.assessment.completed', resourceType: 'jev_assessment', resourceId: row.id });
    });
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(JEV_[A-Z_]+|PERMISSION_DENIED|ORGANIZATION_ACCESS_DENIED|ACCOUNT_INACTIVE|PROFESSIONAL_VERIFICATION_REQUIRED)$/.test(error.code) ? error.code : 'JEV_ASSESSMENT_UNAVAILABLE';
    await withTenant(context, (tx) => tx.emrJevAssessment.updateMany({ where: { id: job.assessmentId, processingStatus: { in: ['QUEUED','RUNNING'] } }, data: { processingStatus: code === 'JEV_ASSESSMENT_STALE' ? 'STALE' : 'FAILED', errorCode: code, finishedAt: new Date() } }));
  } finally { await prisma.jevAssessmentJob.updateMany({ where: { id: job.id, status: 'RUNNING' }, data: { status: 'FINISHED', finishedAt: new Date() } }); }
  return true;
}
