import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePermission, requirePlatform } from '../../middleware/accessMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { sensitiveLimiter } from '../../middleware/rateLimitMiddleware.js';

const router = express.Router();
export const publicPackageRoutes = express.Router();
const empty = z.object({}).strict();
const envelope = (body, params = empty) => z.object({ body, query: empty, params });
const id = z.uuid();
const prices = z.object({
  monthlyPriceMinor: z.number().int().min(0).max(2_000_000_000),
  annualPriceMinor: z.number().int().min(0).max(2_000_000_000),
  currency: z.literal('NGN'),
  moduleKeys: z.array(z.string().regex(/^[a-z][a-z0-9._-]{1,79}$/)).min(1).max(50).refine((items) => new Set(items).size === items.length),
}).strict();
const createPackage = envelope(z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9-]{2,31}$/),
  name: z.string().trim().min(3).max(120),
  description: z.string().trim().min(3).max(500),
  recommended: z.boolean().default(false),
  branchLimit: z.number().int().min(1).max(10_000),
  storageLimitGb: z.number().int().min(1).max(1_000_000),
  supportLevel: z.enum(['STANDARD', 'PRIORITY', 'DEDICATED']),
  version: prices,
}).strict());
const createVersion = envelope(prices, z.object({ packageId: id }).strict());
const publishVersion = envelope(empty.optional(), z.object({ packageId: id, versionId: id }).strict());

const publicVersion = (row) => ({
  id: row.id, version: row.version, currency: row.currency,
  monthlyPriceMinor: row.monthlyPriceMinor, annualPriceMinor: row.annualPriceMinor,
  moduleKeys: row.moduleKeys, status: row.status, publishedAt: row.publishedAt,
});
const publicPackage = (row) => ({
  id: row.id, code: row.code, name: row.name, description: row.description,
  recommended: row.recommended, active: row.active, branchLimit: row.branchLimit,
  storageLimitGb: row.storageLimitGb, supportLevel: row.supportLevel,
  publishedVersion: row.publishedVersion,
  versions: row.versions.map(publicVersion),
});
const failure = (res, code, status) => res.status(status).json({ status: 'error', error: { code, message: code.replaceAll('_', ' ').toLowerCase() } });
const handle = (work) => async (req, res, next) => { try { await work(req, res); } catch (error) {
  if (error.code === 'P2002') return failure(res, 'CATALOG_CONFLICT', 409);
  return next(error);
} };

publicPackageRoutes.get('/', handle(async (req, res) => {
  const rows = await prisma.platformPackage.findMany({
    where: { active: true, publishedVersion: { not: null } },
    include: { versions: { where: { status: 'PUBLISHED' } } },
    orderBy: [{ recommended: 'desc' }, { name: 'asc' }],
  });
  res.set('Cache-Control', 'public, max-age=60').json({ status: 'success', data: { items: rows.map((row) => publicPackage({ ...row, versions: row.versions.filter((version) => version.version === row.publishedVersion) })) } });
}));

router.use(protect, requirePlatform, requirePermission('platform.catalog.manage'), requireRecentMfa);

router.get('/', handle(async (req, res) => {
  const rows = await prisma.platformPackage.findMany({ include: { versions: { orderBy: { version: 'desc' } } }, orderBy: { createdAt: 'desc' } });
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { items: rows.map(publicPackage) } });
}));

router.post('/', sensitiveLimiter, validate(createPackage), handle(async (req, res) => {
  const { version, ...metadata } = req.body;
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.platformPackage.create({ data: { ...metadata, versions: { create: { ...version, version: 1, createdByUserId: req.user.id } } }, include: { versions: true } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_PACKAGE_CREATED', description: 'Commercial package draft created', meta: { packageId: created.id, version: 1 } } });
    return created;
  });
  res.status(201).set('Cache-Control', 'no-store').json({ status: 'success', data: publicPackage(row) });
}));

router.post('/:packageId/versions', sensitiveLimiter, validate(createVersion), handle(async (req, res) => {
  const row = await prisma.$transaction(async (tx) => {
    const pkg = await tx.platformPackage.findUnique({ where: { id: req.params.packageId }, include: { versions: { orderBy: { version: 'desc' } } } });
    if (!pkg) return null;
    if (pkg.versions.some((version) => version.status === 'DRAFT')) return 'DRAFT_EXISTS';
    const version = await tx.platformPackageVersion.create({ data: { ...req.body, packageId: pkg.id, version: (pkg.versions[0]?.version ?? 0) + 1, createdByUserId: req.user.id } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_PACKAGE_VERSION_CREATED', description: 'Commercial package price draft created', meta: { packageId: pkg.id, versionId: version.id } } });
    return version;
  });
  if (!row) return failure(res, 'PACKAGE_NOT_FOUND', 404);
  if (row === 'DRAFT_EXISTS') return failure(res, 'DRAFT_EXISTS', 409);
  res.status(201).set('Cache-Control', 'no-store').json({ status: 'success', data: publicVersion(row) });
}));

router.post('/:packageId/versions/:versionId/publish', sensitiveLimiter, validate(publishVersion), handle(async (req, res) => {
  const result = await prisma.$transaction(async (tx) => {
    const pkg = await tx.platformPackage.findUnique({ where: { id: req.params.packageId } });
    const version = await tx.platformPackageVersion.findFirst({ where: { id: req.params.versionId, packageId: req.params.packageId } });
    if (!pkg || !version) return 'NOT_FOUND';
    if (version.status !== 'DRAFT') return 'INVALID_STATE';
    const updated = await tx.platformPackageVersion.updateMany({ where: { id: version.id, status: 'DRAFT' }, data: { status: 'PUBLISHED', publishedAt: new Date() } });
    if (updated.count !== 1) return 'INVALID_STATE';
    if (pkg.publishedVersion !== null) await tx.platformPackageVersion.updateMany({ where: { packageId: pkg.id, version: pkg.publishedVersion, status: 'PUBLISHED' }, data: { status: 'RETIRED' } });
    await tx.platformPackage.update({ where: { id: pkg.id }, data: { publishedVersion: version.version } });
    await tx.activityLog.create({ data: { userId: req.user.id, type: 'PLATFORM_PACKAGE_PUBLISHED', description: 'Commercial package version published', meta: { packageId: pkg.id, versionId: version.id, version: version.version } } });
    return version.version;
  });
  if (result === 'NOT_FOUND') return failure(res, 'PACKAGE_NOT_FOUND', 404);
  if (result === 'INVALID_STATE') return failure(res, 'INVALID_STATE', 409);
  res.set('Cache-Control', 'no-store').json({ status: 'success', data: { packageId: req.params.packageId, publishedVersion: result } });
}));

export default router;
