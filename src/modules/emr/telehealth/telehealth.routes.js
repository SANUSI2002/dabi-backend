// /api/v1/emr/organizations/:organizationId/telehealth/designation
// A doctor, signed into a hospital, designates it as the EMR that receives their completed
// telemedicine visits (UC-2). Only the doctor's own designation is readable; another hospital's
// id is never revealed.
import express from 'express';
import { z } from 'zod';
import prisma from '../../../config/db.js';
import { withTenant } from '../core/db.js';
import { recordAudit } from '../core/audit.js';
import { EmrError } from '../core/errors.js';
import { handle, validateEmr } from '../core/validate.js';

const router = express.Router({ mergeParams: true });
const shape = validateEmr(z.object({ params: z.object({ organizationId: z.uuid() }).strict(), query: z.object({}).strict() }));

const requireDoctor = (req, res, next) =>
  (req.emr.roles.includes('DOCTOR') ? next() : next(new EmrError('PERMISSION_DENIED', { message: 'Only doctors can designate a telehealth organization.' })));

const profileOf = (userId) => prisma.professionalProfile.findUnique({ where: { userId }, select: { professionType: true, verificationStatus: true, emrOrganizationId: true } });

const view = (profile, organizationId) => ({
  designated: profile?.emrOrganizationId === organizationId,
  designatedElsewhere: !!profile?.emrOrganizationId && profile.emrOrganizationId !== organizationId,
});

router.get('/', shape, requireDoctor, handle(async (req, res) => {
  res.json({ status: 'success', data: view(await profileOf(req.emr.userId), req.emr.organizationId) });
}));

router.put('/', shape, requireDoctor, handle(async (req, res) => {
  const { count } = await prisma.professionalProfile.updateMany({
    where: { userId: req.emr.userId, professionType: 'DOCTOR', verificationStatus: 'VERIFIED' },
    data: { emrOrganizationId: req.emr.organizationId },
  });
  if (count !== 1) throw new EmrError('PERMISSION_DENIED', { message: 'A verified doctor profile is required.' });
  await withTenant(req.emr, (tx) => recordAudit(tx, req.emr, { action: 'telehealth.designated', resourceType: 'telehealth_designation', resourceId: req.emr.userId }));
  res.json({ status: 'success', data: view(await profileOf(req.emr.userId), req.emr.organizationId) });
}));

router.delete('/', shape, requireDoctor, handle(async (req, res) => {
  // Only clears a designation that points at THIS organization.
  const { count } = await prisma.professionalProfile.updateMany({
    where: { userId: req.emr.userId, emrOrganizationId: req.emr.organizationId },
    data: { emrOrganizationId: null },
  });
  if (count) await withTenant(req.emr, (tx) => recordAudit(tx, req.emr, { action: 'telehealth.undesignated', resourceType: 'telehealth_designation', resourceId: req.emr.userId }));
  res.json({ status: 'success', data: view(await profileOf(req.emr.userId), req.emr.organizationId) });
}));

export default router;
