// Staff: /api/v1/accounting/organizations/:organizationId/portal-links — create (acct.post, optionally
// emailed to the customer), list a party's links (acct.view), revoke (acct.post).
// Public: /api/v1/accounting/portal/:token — no account; the token is the credential. Replies are never
// cached, never indexed and never send the URL on as a referrer. A bad, expired or revoked token gets the
// same 404 as one that never existed.
import express from 'express';
import { z } from 'zod';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import { createLimiter } from '../../../middleware/rateLimitMiddleware.js';
import { sendPdf } from '../documents/financePdf.js';
import * as portal from './portal.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const when = z.iso.datetime({ offset: true }).or(z.iso.date());
const partyKind = z.enum(['customer', 'vendor']);

export const portalLinkRoutes = express.Router({ mergeParams: true });
portalLinkRoutes.post('/', check(z.object({ params: z.object(org).strict(), query: noQuery, body: z.object({ partyKind, partyId: z.uuid(), days: z.number().int().min(1).max(180).optional(), email: z.boolean().optional() }).strict() })),
  handle(async (req, res) => send(res, await portal.createLink(req.emr, req.body), 201)));
portalLinkRoutes.get('/', check(z.object({ params: z.object(org).strict(), query: z.object({ partyKind, partyId: z.uuid() }).strict() })),
  handle(async (req, res) => send(res, await portal.listLinks(req.emr, req.query))));
portalLinkRoutes.post('/:id/revoke', check(z.object({ params: z.object({ ...org, id: z.uuid() }).strict(), query: noQuery, body: z.object({}).strict() })),
  handle(async (req, res) => send(res, await portal.revokeLink(req.emr, req.params.id))));

const token = z.string().regex(/^[\w-]{40,60}$/);
const portalLimiter = createLimiter({ kind: 'portal', field: 'token', max: 120 });
export const publicPortalRoutes = express.Router();
publicPortalRoutes.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' }); next(); });
publicPortalRoutes.get('/:token', portalLimiter, check(z.object({ params: z.object({ token }).strict(), query: z.object({ from: when.optional(), to: when.optional() }).strict() })),
  handle(async (req, res) => send(res, await portal.portalView(req.params.token, req.query))));
publicPortalRoutes.get('/:token/statement.pdf', portalLimiter, check(z.object({ params: z.object({ token }).strict(), query: z.object({ from: when.optional(), to: when.optional(), download: z.enum(['1']).optional() }).strict() })),
  handle(async (req, res) => sendPdf(res, await portal.portalStatementPdf(req.params.token, req.query), { download: Boolean(req.query.download) })));
publicPortalRoutes.get('/:token/invoices/:id.pdf', portalLimiter, check(z.object({ params: z.object({ token, id: z.uuid() }).strict(), query: z.object({ download: z.enum(['1']).optional() }).strict() })),
  handle(async (req, res) => sendPdf(res, await portal.portalInvoicePdf(req.params.token, req.params.id), { download: Boolean(req.query.download) })));
publicPortalRoutes.get('/:token/payments/:id/remittance.pdf', portalLimiter, check(z.object({ params: z.object({ token, id: z.uuid() }).strict(), query: z.object({ download: z.enum(['1']).optional() }).strict() })),
  handle(async (req, res) => sendPdf(res, await portal.portalRemittancePdf(req.params.token, req.params.id), { download: Boolean(req.query.download) })));
