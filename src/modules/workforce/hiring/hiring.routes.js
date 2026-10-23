// /api/v1/workforce/organizations/:organizationId/hiring (recruitment, talent pool, vacancies,
// onboarding, offboarding). Mounted under the Workforce tenant router.
//
// Who can do what (migrations 20261110090000_workforce_people, 20261113090000_workforce_hiring):
//   HR officer, owner, hospital admin (hr.read / hr.manage):  everything here
//   a department's HOD or deputy (workforce.self):            raise, edit and withdraw vacancy requests
//                                                             for that department, and see their own
// Vacancy approval itself runs through POST /workflows/instances { triggerType: 'vacancy', reference }.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as hiring from './hiring.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const date = z.iso.date();
const money = z.number().min(0).max(1e12);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const atLeastOne = (shape, params = withId) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const clientId = { id: z.uuid().optional() };
const vacancyFields = {
  departmentId: z.uuid(), jobPositionId: z.uuid().optional(), roleTitle: text(160), headcount: z.number().int().min(1).max(500), vacancyTypeId: z.string().trim().max(60).optional(),
  reason: text(2000), requirements: free(2000).optional(), salaryMin: money.optional(), salaryMax: money.optional(),
};

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  empty: body({}, withId),
  requisition: body({ ...clientId, title: text(160), description: free(2000).optional(), departmentId: z.uuid().optional(), jobPositionId: z.uuid().optional(), vacancy: z.number().int().min(1).max(500), startDate: date, endDate: date.optional(), managerIds: z.array(z.uuid()).max(10).optional() }),
  candidate: body({ ...clientId, requisitionId: z.uuid(), name: text(160), email: z.email().max(160), phone: free(30).optional(), source: z.string().trim().min(1).max(120) /* a Recruitment Sources item, checked by the service */, referredBy: z.uuid().optional() }),
  move: body({ stageId: z.uuid() }, withId),
  rate: body({ rating: z.number().int().min(0).max(5) }, withId),
  reject: body({ reason: text(200) }, withId),
  interview: body({ ...clientId, candidateId: z.uuid(), scheduledAt: z.iso.datetime({ offset: true }), interviewerIds: z.array(z.uuid()).min(1).max(10), notes: free(1000).optional() }),
  feedback: body({ feedback: text(2000) }, withId),
  talent: body({ ...clientId, candidateId: z.uuid(), skillZone: text(80), reason: text(500) }),
  note: body({ text: text(2000) }, withId),
  document: body({ type: text(80), filename: text(200), sizeKb: z.number().int().min(0).max(102400).optional() }, withId),
  take: body({ requisitionId: z.uuid(), statusCode: text(40), statusLabel: text(80), stageType: z.enum(['Applied', 'Test', 'Interview', 'Hired', 'Cancelled']), candidateId: z.uuid().optional() }, withId),
  createVacancy: body({ ...clientId, ...vacancyFields }),
  updateVacancy: atLeastOne(Object.fromEntries(Object.entries(vacancyFields).map(([k, s]) => [k, s.optional()]))),
  onboarding: body({ ...clientId, candidateId: z.uuid() }),
  task: body({ taskId: z.string().regex(/^ob-t\d{1,2}$/) }, withId),
  upload: body({ taskId: z.string().regex(/^ob-t\d{1,2}$/), title: text(200) }, withId),
  terms: atLeastOne({ resumptionDate: date.optional(), basicSalary: z.number().positive().max(1e12).optional() }),
  convert: body({ employeeId: z.uuid().optional(), role: text(80), cadre: free(80).optional() }, withId),
  offerTemplate: body({ text: text(20000) }),
  offboarding: body({ ...clientId, employeeId: z.uuid(), reason: text(120), lastWorkingDate: date }),
  exitRecord: atLeastOne({ exitInterviewNotes: text(4000).optional(), handoverNotes: text(4000).optional(), fnfAmount: z.number().positive().max(1e12).optional() }),
};

const HR = ['hr.read', 'hr.manage'];
const STAFF = ['workforce.self', 'hr.manage'];
export const hiringRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, perms, fn, status = 200) => hiringRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));

r('get', '/', v.overview, ['workforce.self', 'hr.read'], (req) => hiring.overview(req.emr));
r('post', '/requisitions', v.requisition, HR, (req) => hiring.addRequisition(req.emr, req.body), 201);
r('post', '/requisitions/:id/close', v.empty, HR, (req) => hiring.closeRequisition(req.emr, req.params.id));
r('post', '/candidates', v.candidate, HR, (req) => hiring.addCandidate(req.emr, req.body), 201);
r('post', '/candidates/:id/move', v.move, HR, (req) => hiring.moveCandidate(req.emr, req.params.id, req.body));
r('post', '/candidates/:id/rate', v.rate, HR, (req) => hiring.rateCandidate(req.emr, req.params.id, req.body));
r('post', '/candidates/:id/reject', v.reject, HR, (req) => hiring.rejectCandidate(req.emr, req.params.id, req.body));
r('post', '/candidates/:id/hire', v.empty, HR, (req) => hiring.hireCandidate(req.emr, req.params.id));
r('post', '/interviews', v.interview, HR, (req) => hiring.scheduleInterview(req.emr, req.body), 201);
r('post', '/interviews/:id/complete', v.feedback, HR, (req) => hiring.completeInterview(req.emr, req.params.id, req.body));
r('post', '/talent-pool', v.talent, HR, (req) => hiring.addToTalentPool(req.emr, req.body), 201);
r('post', '/talent-pool/:id/notes', v.note, HR, (req) => hiring.addTalentNote(req.emr, req.params.id, req.body), 201);
r('post', '/talent-pool/:id/documents', v.document, HR, (req) => hiring.addTalentDocument(req.emr, req.params.id, req.body), 201);
r('post', '/talent-pool/:id/take-to-recruitment', v.take, HR, (req) => hiring.takeToRecruitment(req.emr, req.params.id, req.body));

r('post', '/vacancies', v.createVacancy, STAFF, (req) => hiring.createVacancy(req.emr, req.body), 201);
hiringRoutes.patch('/vacancies/:id', check(v.updateVacancy), allow(...STAFF), handle(async (req, res) => send(res, await hiring.updateVacancy(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/vacancies/:id/cancel', v.empty, STAFF, (req) => hiring.cancelVacancy(req.emr, req.params.id));
r('post', '/vacancies/:id/filled', v.empty, HR, (req) => hiring.markVacancyFilled(req.emr, req.params.id));

r('post', '/onboarding', v.onboarding, HR, (req) => hiring.startOnboarding(req.emr, req.body), 201);
r('post', '/onboarding/:id/tasks', v.task, HR, (req) => hiring.toggleTask(req.emr, req.params.id, req.body));
r('post', '/onboarding/:id/documents', v.upload, HR, (req) => hiring.uploadTaskDocument(req.emr, req.params.id, req.body), 201);
r('patch', '/onboarding/:id', v.terms, HR, (req) => hiring.updateOnboarding(req.emr, req.params.id, req.body));
r('post', '/onboarding/:id/advance', v.empty, HR, (req) => hiring.advanceOnboarding(req.emr, req.params.id));
r('post', '/onboarding/:id/convert', v.convert, HR, (req) => hiring.convertToEmployee(req.emr, req.params.id, req.body), 201);
hiringRoutes.put('/offer-letter-template', check(v.offerTemplate), allow(...HR), handle(async (req, res) => send(res, await hiring.saveOfferTemplate(req.emr, requireVersion(req), req.body))));

r('post', '/offboarding', v.offboarding, HR, (req) => hiring.initiateOffboarding(req.emr, req.body), 201);
r('patch', '/offboarding/:id', v.exitRecord, HR, (req) => hiring.recordExit(req.emr, req.params.id, req.body));
r('post', '/offboarding/:id/advance', v.empty, HR, (req) => hiring.advanceOffboarding(req.emr, req.params.id));
