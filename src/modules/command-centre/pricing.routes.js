// /api/v1/command-centre/pricing — delivery pricing: the version in force, scheduled and past
// versions, creating a new version (with a reason, optionally scheduled), cancelling a scheduled
// one, and a simulator that runs the exact checkout calculation on any inputs.
import express from 'express';
import { z } from 'zod';
import prisma from '../../config/db.js';
import { validate } from '../../middleware/validateMiddleware.js';
import { requireRecentMfa } from '../../middleware/mfaMiddleware.js';
import { DISTANCE_METHODS, DISTANCE_ROUNDING, normalizeConfiguration } from '../checkout-pricing/delivery-pricing.js';
import { roadRoutingConfigured } from '../checkout-pricing/distance.js';
import { activeConfiguration, cancelScheduled, createConfiguration, listConfigurations, quoteDelivery, VERSION_FIELDS } from '../checkout-pricing/pricing-configurations.js';
import { adminAudit, allow, ccError, handle, reason } from './cc.common.js';

export const pricingRoutes = express.Router();

const money = z.number().int().min(0).max(1_000_000_000);
const km = z.number().min(0).max(1000);
const point = z.object({ latitude: z.number().finite().min(-90).max(90), longitude: z.number().finite().min(-180).max(180) }).strict();
const label = z.string().trim().min(2).max(80).regex(/^[^\p{Cc}]+$/u, 'Contains control characters');

/** Any subset of the rule set; omitted fields are copied from the version in force. */
const rules = z.object({
  currency: z.literal('NGN').optional(),
  platformFeeMinor: money.optional(),
  deliveryRatePerKmMinor: z.number().int().min(0).max(10_000_000).optional(),
  baseFeeMinor: money.optional(),
  includedDistanceKm: km.optional(),
  minimumFeeMinor: money.optional(),
  maximumFeeMinor: money.nullable().optional(),
  maxDistanceKm: z.number().gt(0).max(1000).nullable().optional(),
  distanceMethod: z.enum(DISTANCE_METHODS).optional(),
  roadFallbackToStraightLine: z.boolean().optional(),
  distanceRounding: z.enum(DISTANCE_ROUNDING).optional(),
  feeRoundingMinor: z.number().int().min(1).max(100_000).optional(),
  bands: z.array(z.object({ fromKm: km, toKm: z.number().gt(0).max(1000).nullable(), ratePerKmMinor: z.number().int().min(0).max(10_000_000) }).strict()).max(20).optional(),
  zones: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{2,40}$/, 'Zone ids are lowercase letters, digits and hyphens'),
    name: label,
    centre: point,
    radiusKm: z.number().min(0.1).max(500),
    ratePerKmMinor: z.number().int().min(0).max(10_000_000).nullable().optional(),
    surchargeMinor: money.nullable().optional(),
    serviceable: z.boolean().default(true),
  }).strict()).max(50).optional(),
  restrictToZones: z.boolean().optional(),
  freeDeliveryThresholdMinor: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  smallOrderThresholdMinor: z.number().int().min(1).max(1_000_000_000).nullable().optional(),
  smallOrderFeeMinor: money.optional(),
  surcharges: z.array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,23}$/), label, amountMinor: z.number().int().min(1).max(100_000_000) }).strict()).max(10).optional(),
  quoteTtlMinutes: z.number().int().min(1).max(1440).optional(),
}).strict();

const noBody = z.object({}).strict();
const versionParams = z.object({ version: z.coerce.number().int().min(1) }).strict();

/** Road distance with no routing key and no fallback would make every delivery quote fail. */
function checkRoutable(next) {
  if (next.distanceMethod === 'ROAD' && !roadRoutingConfigured() && !next.roadFallbackToStraightLine) {
    throw ccError('ROUTING_NOT_CONFIGURED', 400, 'Road distance needs a routing key on the server (GOOGLE_ROUTES_API_KEY). Keep straight-line distance or allow straight-line fallback.');
  }
}

const READ = ['platform.pricing.manage', 'platform.finance.read', 'platform.ops.read'];

pricingRoutes.get('/delivery', allow(...READ), validate(z.object({ body: noBody.optional(), query: z.object({}).strict(), params: z.object({}).strict() })),
  handle(async () => ({ active: await activeConfiguration(), versions: await listConfigurations(), routing: { roadConfigured: roadRoutingConfigured(), provider: roadRoutingConfigured() ? 'Google Routes API' : null } })));

pricingRoutes.post('/delivery', allow('platform.pricing.manage'), requireRecentMfa,
  validate(z.object({ body: rules.extend({ reason, effectiveAt: z.iso.datetime({ offset: true }).optional() }).strict(), query: z.object({}).strict(), params: z.object({}).strict() })),
  handle(async (req, res) => {
    const { reason: why, effectiveAt, ...values } = req.body;
    const current = await activeConfiguration();
    checkRoutable({ ...current, ...values });
    const result = await prisma.$transaction(async (tx) => {
      const { before, after } = await createConfiguration(tx, req.user.id, values, { reason: why, effectiveAt });
      const pick = (c) => Object.fromEntries(['version', ...VERSION_FIELDS].map((f) => [f, c[f]]));
      await adminAudit(tx, req, {
        summary: `Delivery pricing version ${after.version} ${effectiveAt ? `scheduled for ${after.effectiveAt.toISOString()}` : 'took effect'}`,
        resourceType: 'delivery_pricing', resourceId: String(after.version), reason: why, before: pick(before), after: pick(after),
      });
      return after;
    });
    res.status(201);
    return result;
  }));

pricingRoutes.post('/delivery/:version/cancel', allow('platform.pricing.manage'), requireRecentMfa,
  validate(z.object({ body: z.object({ reason }).strict(), query: z.object({}).strict(), params: versionParams })),
  handle(async (req) => prisma.$transaction(async (tx) => {
    const cancelled = await cancelScheduled(tx, req.user.id, req.params.version);
    await adminAudit(tx, req, { summary: `Cancelled scheduled delivery pricing version ${cancelled.version}`, resourceType: 'delivery_pricing', resourceId: String(cancelled.version), reason: req.body.reason });
    return cancelled;
  })));

/**
 * Runs the checkout calculation. Without `rules` it prices with the version in force; with `rules`
 * it prices a draft (the version in force with those changes) without saving anything.
 */
pricingRoutes.post('/delivery/simulate', allow(...READ),
  validate(z.object({
    body: z.object({
      rules: rules.optional(),
      origin: point,
      destination: point,
      subtotalMinor: money,
      tierRadiusKm: z.number().gt(0).max(1000).nullable().optional(),
    }).strict(),
    query: z.object({}).strict(),
    params: z.object({}).strict(),
  })),
  handle(async (req) => {
    const active = await activeConfiguration();
    const config = req.body.rules ? normalizeConfiguration({ ...active, ...req.body.rules, version: active.version, effectiveAt: null }) : active;
    if (req.body.rules) checkRoutable(config);
    const quote = await quoteDelivery({ config, origin: req.body.origin, destination: req.body.destination, subtotalMinor: req.body.subtotalMinor, tierRadiusKm: req.body.tierRadiusKm ?? null });
    return { draft: Boolean(req.body.rules), basedOnVersion: active.version, quote };
  }));
