// Public waitlist for products that are not open yet (first: Sabi AI).
// Contact details only; the form asks people not to include health information. Joining twice just
// updates the details, and the answer is the same either way, so the endpoint never reveals whether
// an email address is already on a list.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { createLimiter } from '../../middleware/rateLimitMiddleware.js';
import { validate } from '../../middleware/validateMiddleware.js';

const PRODUCTS = { 'sabi-ai': 'SABI_AI' };
const ROLES = ['PROFESSIONAL', 'PATIENT', 'CAREGIVER', 'ORGANISATION', 'OTHER'];

const joinSchema = z.object({ body: z.object({
  product: z.enum(Object.keys(PRODUCTS)),
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().max(120).optional(),
  role: z.enum(ROLES),
  organisation: z.string().trim().max(160).optional(),
  consent: z.literal(true),
  source: z.string().trim().max(64).optional(),
}).strict() });

const router = express.Router();

router.post('/', createLimiter({ kind: 'waitlist', max: 10 }), validate(joinSchema), async (req, res, next) => {
  const { product, email, name, role, organisation, source } = req.body;
  const details = { fullName: name || null, role, organisation: organisation || null, source: source || null, consentedAt: new Date() };
  try {
    await prisma.waitlistSignup.upsert({
      where: { product_email: { product: PRODUCTS[product], email } },
      create: { product: PRODUCTS[product], email, ...details },
      update: details,
    });
    return res.status(200).json({ status: 'success', data: { joined: true } });
  } catch (error) {
    return next(error);
  }
});

export default router;
