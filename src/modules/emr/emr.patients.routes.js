import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { requireOrganization, requirePermission } from '../../middleware/accessMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { approvedEmrFor, emrPatientRegistryEnabled } from './emr.entitlement.js';

const router = express.Router();
const params = z.object({ organizationId: z.uuid() }).strict();
const text = z.string().trim().min(1).max(80).regex(/^[^\p{Cc}\p{Cf}]+$/u);
const birthDate = z.iso.date().refine((value) => value >= '1850-01-01' && value <= new Date().toISOString().slice(0, 10));
const create = z.object({
  givenName: text, familyName: text, dateOfBirth: birthDate,
  sex: z.enum(['FEMALE', 'MALE', 'OTHER', 'UNKNOWN']).default('UNKNOWN'),
  medicalRecordNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/),
}).strict();
const list = z.object({ page: z.coerce.number().int().min(1).max(100).default(1), q: z.string().trim().max(50).optional() }).strict();
const patientSelect = { id: true, medicalRecordNumber: true, givenName: true, familyName: true, dateOfBirth: true, sex: true, createdAt: true };
const safe = (handler) => async (req, res, next) => { try { await handler(req, res); } catch (error) {
  if (error?.code === 'P2002') return res.status(409).json({ status: 'error', error: { code: 'MEDICAL_RECORD_NUMBER_IN_USE', message: 'Medical record number is already in use for this organization.' } });
  return next(error);
} };

const authorize = async (req, res, next) => {
  try {
    if (req.params.organizationId !== req.accessContext.organization.id) {
      return res.status(403).json({ status: 'error', error: { code: 'ORGANIZATION_ACCESS_DENIED', message: 'Access denied.' } });
    }
    if (!await approvedEmrFor(req.accessContext)) {
      return res.status(403).json({ status: 'error', error: { code: 'EMR_ACCESS_DENIED', message: 'This organization has no active EMR entitlement.' } });
    }
    if (!emrPatientRegistryEnabled()) {
      return res.status(503).json({ status: 'error', error: { code: 'EMR_PATIENT_REGISTRY_DISABLED', message: 'The clinical test registry is not enabled.' } });
    }
    req.emrOrganizationId = req.accessContext.organization.id;
    return next();
  } catch (error) { return next(error); }
};

router.get('/:organizationId/patients', protect, validate(z.object({ params, query: list })), requireOrganization, authorize, requirePermission('patient.read'), safe(async (req, res) => {
  const { q, page } = req.query;
  const where = { organizationId: req.emrOrganizationId, ...(q ? { OR: [
    { medicalRecordNumber: { contains: q, mode: 'insensitive' } },
    { givenName: { contains: q, mode: 'insensitive' } },
    { familyName: { contains: q, mode: 'insensitive' } },
  ] } : {}) };
  const rows = await prisma.$transaction(async (tx) => {
    const items = await tx.emrPatient.findMany({ where, select: patientSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * 25, take: 26 });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'EMR_PATIENT_LIST_VIEWED', description: 'Organization patient registry viewed', meta: { organizationId: req.emrOrganizationId, queryUsed: !!q, page } } });
    return items;
  });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { items: rows.slice(0, 25), nextPage: rows.length > 25 ? page + 1 : null } });
}));

router.post('/:organizationId/patients', protect, validate(z.object({ params, query: z.object({}).strict(), body: create })), requireOrganization, authorize, requirePermission('patient.register'), safe(async (req, res) => {
  const patient = await prisma.$transaction(async (tx) => {
    const item = await tx.emrPatient.create({ data: {
      organizationId: req.emrOrganizationId, createdByUserId: req.user.id,
      medicalRecordNumber: req.body.medicalRecordNumber, givenName: req.body.givenName,
      familyName: req.body.familyName, dateOfBirth: new Date(`${req.body.dateOfBirth}T00:00:00.000Z`), sex: req.body.sex,
    }, select: patientSelect });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'EMR_PATIENT_REGISTERED', description: 'Patient registered in organization', meta: { organizationId: req.emrOrganizationId, patientId: item.id } } });
    return item;
  });
  res.status(201).set('Cache-Control', 'no-store').json({ status: 'success', data: patient });
}));

export default router;
