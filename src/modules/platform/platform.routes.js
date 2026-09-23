import express from 'express';
import prisma from '../../config/db.js';
import { protect } from '../../middleware/authMiddleware.js';
import { requirePermission, requirePlatform } from '../../middleware/accessMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';

const router = express.Router();

router.get('/organizations', protect, requirePlatform, requirePermission('platform.onboarding.review'), requireRecentMfa, async (req, res, next) => {
  const page = Number(req.query.page ?? 1);
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) {
    return res.status(400).json({ status: 'error', error: { code: 'INVALID_PAGE', message: 'Page must be between 1 and 200.' } });
  }
  try {
    const rows = await prisma.identityOrganization.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * 50,
      take: 51,
      select: {
        id: true, type: true, createdAt: true,
        organisation: { select: { name: true, status: true } },
        pharmacy: { select: { name: true, complianceStatus: true } },
      },
    });
    return res.json({ status: 'success', data: {
      items: rows.slice(0, 50).map((row) => ({
        id: row.id,
        type: row.type,
        name: row.organisation?.name ?? row.pharmacy?.name ?? 'Unnamed organization',
        status: row.organisation?.status ?? row.pharmacy?.complianceStatus ?? 'PENDING',
        createdAt: row.createdAt,
      })),
      nextPage: rows.length > 50 ? page + 1 : null,
    } });
  } catch (error) { return next(error); }
});

export default router;
