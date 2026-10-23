// /api/v1/workforce/organizations/:organizationId/people
// Mounted under the Workforce tenant router (auth, tenant, Workforce entitlement, rate limit ran).
//
// Who can do what (migration 20261110090000_workforce_people):
//   HR officer, owner:   everything below, including bank and personal details
//   hospital admin:      everything except bank and personal details
//   every staff role:    the directory (names, roles, departments) for rosters
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as people from './people.service.js';
import { hrAuditEvents } from './audit.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const opt = (schema) => schema.nullable().optional();
const date = z.iso.date();
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const withId = (key) => ({ ...org, [key]: z.uuid() });
// Creates may carry the id the screen already uses (a UUID it generated), so later steps can refer to it.
const clientId = { id: z.uuid().optional() };

const profile = {
  phone: opt(text(30)), email: opt(z.email().max(160)), license: opt(text(60)), dob: opt(date), gender: opt(z.enum(['Male', 'Female', 'Other'])),
  maritalStatus: opt(z.enum(['Single', 'Married', 'Divorced', 'Widowed'])), address: opt(text(200)), lga: opt(text(80)), state: opt(text(80)),
  emergencyContactName: opt(text(120)), emergencyContactPhone: opt(text(30)), emergencyContactRelation: opt(text(40)), qualification: opt(text(160)),
  companyId: opt(z.uuid()), departmentId: opt(z.uuid()), jobPositionId: opt(z.uuid()), jobRoleId: opt(z.uuid()), employeeTypeId: opt(z.uuid()), reportingManagerId: opt(z.uuid()),
  dateJoining: opt(date), contractEndDate: opt(date), workEmail: opt(z.email().max(160)), workPhone: opt(text(30)), tagIds: z.array(z.uuid()).max(20).optional(),
  bankName: opt(text(80)), accountNumber: opt(z.string().regex(/^\d{10}$/, 'A NUBAN account number is 10 digits')), bankBranch: opt(text(80)), userId: opt(z.string().min(1).max(64)),
};
const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  createEmployee: body({ ...clientId, name: text(160), role: text(80), cadre: z.string().trim().max(80).default(''), hireDate: date, ...profile }),
  updateEmployee: z.object({
    params: z.object(withId('employeeId')).strict(), query: noQuery,
    body: z.object({ name: text(160).optional(), role: text(80).optional(), cadre: z.string().trim().max(80).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional(), ...profile }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  empty: body({}),
  company: body({ ...clientId, name: text(120), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,29}$/), address: opt(text(200)), lga: opt(text(80)), state: opt(text(80)), country: text(80).default('Nigeria') }),
  department: body({
    ...clientId, name: text(120), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/), description: text(500).optional(), companyIds: z.array(z.uuid()).max(20).default([]),
    hodId: z.uuid().optional(), deputyHodId: z.uuid().optional(), parentDepartmentId: z.uuid().optional(),
  }),
  updateDepartment: z.object({
    params: z.object(withId('departmentId')).strict(), query: noQuery,
    body: z.object({ name: text(120).optional(), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/).optional(), description: opt(text(500)), status: z.enum(['Active', 'Inactive', 'Merging', 'Dissolved']).optional(), companyIds: z.array(z.uuid()).max(20).optional(), parentDepartmentId: opt(z.uuid()) }).strict()
      .refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
  }),
  leader: body({ role: z.enum(['hod', 'deputy-hod']), employeeId: z.uuid().nullable(), effectiveDate: date, reason: text(500).optional() }, withId('departmentId')),
  member: body({ employeeId: z.uuid() }, withId('departmentId')),
  jobPosition: body({ ...clientId, name: text(120), departmentId: z.uuid() }),
  jobRole: body({ ...clientId, name: text(120), jobPositionId: z.uuid() }),
  named: body({ ...clientId, name: text(80) }),
  tag: body({ ...clientId, name: text(60), color: z.string().trim().max(20).regex(/^[#a-zA-Z0-9-]+$/) }),
  actionType: body({ ...clientId, name: text(80), blockOption: z.boolean().default(false) }),
  requestDocs: body({ ids: z.array(z.uuid()).max(200).optional(), employeeIds: z.array(z.uuid()).min(1).max(200), title: text(160), category: text(80), notifyBeforeDays: z.number().int().min(0).max(365).default(30) }),
  uploadDoc: body({ issueDate: date.optional(), expiryDate: date.optional() }, withId('documentId')),
  reviewDoc: body({ status: z.enum(['Approved', 'Rejected']), rejectReason: text(500).optional() }, withId('documentId')).refine((r) => r.body.status !== 'Rejected' || !!r.body.rejectReason, { path: ['body', 'rejectReason'], message: 'Give the reason for rejecting.' }),
  disciplinary: body({ employeeIds: z.array(z.uuid()).min(1).max(100), actionTypeId: z.uuid(), description: text(2000), unit: z.enum(['Days', 'Hours']), amount: z.number().int().min(0).max(3650), startDate: date, attachment: text(200).optional() }),
  note: body({ note: text(4000) }, withId('employeeId')),
  bonus: body({ delta: z.number().int().min(-10000).max(10000).refine((n) => n !== 0, 'Cannot be zero'), reason: text(500) }, withId('employeeId')),
  qualification: body({ title: text(160), issuingBody: text(160), dateObtained: date, certificateRef: text(80).optional() }, withId('employeeId')),
  policy: body({ ...clientId, category: z.string().trim().min(1).max(120) /* a Policy Categories item, checked by the service */, title: text(160), purpose: text(500), body: text(20000) }),
};

export const peopleRoutes = express.Router({ mergeParams: true });
const R = 'hr.read';
const M = 'hr.manage';
peopleRoutes.get('/', check(v.overview), allow(R), handle(async (req, res) => send(res, await people.overview(req.emr))));
peopleRoutes.get('/directory', check(v.overview), allow('workforce.directory', R), handle(async (req, res) => send(res, await people.directory(req.emr))));
peopleRoutes.get('/audit-events', check(z.object({ params: z.object(org).strict(), query: z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).strict() })), allow('hr.read'), handle(async (req, res) => send(res, await hrAuditEvents(req.emr, req.query))));
peopleRoutes.post('/employees', check(v.createEmployee), allow(M), handle(async (req, res) => send(res, await people.createEmployee(req.emr, req.body), 201)));
peopleRoutes.patch('/employees/:employeeId', check(v.updateEmployee), allow(M), handle(async (req, res) => send(res, await people.updateEmployee(req.emr, req.params.employeeId, requireVersion(req), req.body))));
peopleRoutes.post('/employees/import-members', check(v.empty), allow(M), handle(async (req, res) => send(res, await people.importMembers(req.emr))));
peopleRoutes.post('/employees/:employeeId/notes', check(v.note), allow(M), handle(async (req, res) => send(res, await people.addNote(req.emr, req.params.employeeId, req.body), 201)));
peopleRoutes.post('/employees/:employeeId/bonus', check(v.bonus), allow(M), handle(async (req, res) => send(res, await people.adjustBonus(req.emr, req.params.employeeId, req.body), 201)));
peopleRoutes.post('/employees/:employeeId/qualifications', check(v.qualification), allow(M), handle(async (req, res) => send(res, await people.addQualification(req.emr, req.params.employeeId, req.body), 201)));
peopleRoutes.post('/companies', check(v.company), allow(M), handle(async (req, res) => send(res, await people.createCompany(req.emr, req.body), 201)));
peopleRoutes.post('/departments', check(v.department), allow(M), handle(async (req, res) => send(res, await people.createDepartment(req.emr, req.body), 201)));
peopleRoutes.patch('/departments/:departmentId', check(v.updateDepartment), allow(M), handle(async (req, res) => send(res, await people.updateDepartment(req.emr, req.params.departmentId, requireVersion(req), req.body))));
peopleRoutes.post('/departments/:departmentId/leader', check(v.leader), allow(M), handle(async (req, res) => send(res, await people.changeLeader(req.emr, req.params.departmentId, requireVersion(req), req.body))));
peopleRoutes.post('/departments/:departmentId/members', check(v.member), allow(M), handle(async (req, res) => send(res, await people.addMember(req.emr, req.params.departmentId, req.body))));
peopleRoutes.post('/departments/:departmentId/members/remove', check(v.member), allow(M), handle(async (req, res) => send(res, await people.removeMember(req.emr, req.params.departmentId, req.body))));
peopleRoutes.post('/job-positions', check(v.jobPosition), allow(M), handle(async (req, res) => send(res, await people.createJobPosition(req.emr, req.body), 201)));
peopleRoutes.post('/job-roles', check(v.jobRole), allow(M), handle(async (req, res) => send(res, await people.createJobRole(req.emr, req.body), 201)));
peopleRoutes.post('/employee-types', check(v.named), allow(M), handle(async (req, res) => send(res, await people.createEmployeeType(req.emr, req.body), 201)));
peopleRoutes.post('/tags', check(v.tag), allow(M), handle(async (req, res) => send(res, await people.createTag(req.emr, req.body), 201)));
peopleRoutes.post('/action-types', check(v.actionType), allow(M), handle(async (req, res) => send(res, await people.createActionType(req.emr, req.body), 201)));
peopleRoutes.post('/documents', check(v.requestDocs), allow(M), handle(async (req, res) => send(res, await people.requestDocuments(req.emr, req.body), 201)));
peopleRoutes.post('/documents/:documentId/upload', check(v.uploadDoc), allow(M), handle(async (req, res) => send(res, await people.uploadDocument(req.emr, req.params.documentId, requireVersion(req), req.body))));
peopleRoutes.post('/documents/:documentId/review', check(v.reviewDoc), allow(M), handle(async (req, res) => send(res, await people.reviewDocument(req.emr, req.params.documentId, requireVersion(req), req.body))));
peopleRoutes.post('/disciplinary-actions', check(v.disciplinary), allow(M), handle(async (req, res) => send(res, await people.recordDisciplinary(req.emr, req.body), 201)));
peopleRoutes.post('/policies', check(v.policy), allow(M), handle(async (req, res) => send(res, await people.publishPolicy(req.emr, req.body), 201)));
