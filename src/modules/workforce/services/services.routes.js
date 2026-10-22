// /api/v1/workforce/organizations/:organizationId/services (company assets, helpdesk, disciplinary
// queries). Mounted under the Workforce tenant router.
//
// Who can do what (migration 20261116090000_workforce_services):
//   HR (hr.read / hr.manage):   the asset register, every ticket and query, FAQ publishing
//   every staff role:           ask for an asset for themselves, raise and follow their own tickets,
//   (workforce.self)            work tickets assigned to them, raise queries for their direct reports
// Query countersignature runs through the "query" workflow; "sent" records delivery — nothing is mailed.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import * as services from './services.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const date = z.iso.date();
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const clientId = { id: z.uuid().optional() };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  category: body({ ...clientId, name: text(80), description: free(500).optional() }),
  asset: body({ ...clientId, name: text(120), categoryId: z.uuid(), batchNo: text(60).optional(), trackingId: text(60), purchaseDate: date, purchaseCost: z.number().min(0).max(1e12), expiryDate: date.optional() }),
  request: body({ ...clientId, employeeId: z.uuid(), categoryId: z.uuid(), description: text(1000) }),
  decide: body({ status: z.enum(['Approved', 'Rejected']) }, withId),
  allocate: body({ assetId: z.uuid(), employeeId: z.uuid(), requestId: z.uuid().optional() }),
  return: body({ condition: z.enum(['Good', 'Damaged', 'Lost']), note: free(500).optional() }, withId),
  ticket: body({
    ...clientId, type: z.string().trim().min(1).max(120) /* a Helpdesk Ticket Types item, checked by the service */, title: text(160), description: text(4000),
    assigningType: z.enum(['Individual', 'Department', 'Job Position']), raisedOn: text(160), priority: z.number().int().min(1).max(3),
  }).refine((r) => r.body.assigningType !== 'Individual' || z.uuid().safeParse(r.body.raisedOn).success, 'Choose the person to send it to'),
  ticketStatus: body({ status: z.enum(['New', 'In Progress', 'On Hold', 'Resolved']) }, withId),
  assign: body({ staffIds: z.array(z.uuid()).max(10) }, withId),
  faqCategory: body({ ...clientId, name: text(80) }),
  faq: body({ ...clientId, categoryId: z.uuid(), question: text(300), answer: text(4000) }),
  query: body({ ...clientId, employeeId: z.uuid(), subject: text(200), body: text(8000), responseDeadlineDays: z.number().int().min(1).max(60) }),
  empty: body({}, withId),
};

const HR = ['hr.read', 'hr.manage'];
const STAFF = ['workforce.self', 'hr.read'];
export const serviceRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, perms, fn, status = 200) => serviceRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));

r('get', '/', v.overview, STAFF, (req) => services.overview(req.emr));
r('post', '/asset-categories', v.category, HR, (req) => services.addCategory(req.emr, req.body), 201);
r('post', '/assets', v.asset, HR, (req) => services.addAsset(req.emr, req.body), 201);
r('post', '/asset-requests', v.request, STAFF, (req) => services.requestAsset(req.emr, req.body), 201);
r('post', '/asset-requests/:id/decide', v.decide, HR, (req) => services.decideRequest(req.emr, req.params.id, req.body));
r('post', '/allocations', v.allocate, HR, (req) => services.allocateAsset(req.emr, req.body), 201);
r('post', '/allocations/:id/return', v.return, HR, (req) => services.returnAsset(req.emr, req.params.id, req.body));
r('post', '/tickets', v.ticket, STAFF, (req) => services.createTicket(req.emr, req.body), 201);
r('post', '/tickets/:id/status', v.ticketStatus, STAFF, (req) => services.setTicketStatus(req.emr, req.params.id, req.body));
r('post', '/tickets/:id/assign', v.assign, HR, (req) => services.assignTicket(req.emr, req.params.id, req.body));
r('post', '/faq-categories', v.faqCategory, HR, (req) => services.addFaqCategory(req.emr, req.body), 201);
r('post', '/faqs', v.faq, HR, (req) => services.addFaq(req.emr, req.body), 201);
r('post', '/queries', v.query, STAFF, (req) => services.raiseQuery(req.emr, req.body), 201);
r('post', '/queries/:id/sent', v.empty, HR, (req) => services.markQuerySent(req.emr, req.params.id));
