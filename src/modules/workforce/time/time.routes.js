// /api/v1/workforce/organizations/:organizationId/time (time & attendance, leave, work)
// Mounted under the Workforce tenant router. Route permissions are the outer gate; the service also
// checks whose record it is (self, direct reports, or everyone for workforce.approve/manage).
//
// Who can do what (migration 20261111090000_workforce_time):
//   every staff role (workforce.self):  clock in/out, breaks, own timesheet, leave/overtime/holiday-work requests, log work
//   line managers:                      the same for their direct reports, and decide their requests
//   HR officer, hospital admin, owner:  approve anyone's (workforce.approve) and configure (workforce.manage)
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { requireVersion } from '../../emr/core/concurrency.js';
import { send } from '../../emr/core/http.js';
import * as time from './time.service.js';

const org = { organizationId: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const date = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
const hours = z.number().min(0).max(24);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const withId = { ...org, id: z.uuid() };
const decision = (statuses) => body({ status: z.enum(statuses), note: text(500).optional() }, withId);
const days = z.object(Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, z.union([z.uuid(), z.literal('Off')])]))).strict();
const capture = z.enum(['Attendance', 'Manual', 'Hybrid']);

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  block: body({ name: text(80), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,11}$/), start: hhmm, end: hhmm, overnight: z.boolean(), paidHours: hours, breakMins: z.number().int().min(0).max(600), lateGraceMins: z.number().int().min(0).max(240), classification: z.enum(['Working', 'Off', 'On-call', 'Flexible']), colour: z.string().trim().max(20) }),
  blockActive: body({ active: z.boolean() }, withId),
  schedule: body({ id: z.uuid().optional(), name: text(120), description: text(500).optional(), startDate: date, endDate: date.optional(), days, rotation: z.array(z.union([z.uuid(), z.literal('Off')])).max(56).optional(), rotationAnchor: date.optional(), holidayRule: z.enum(['Observe as non-working', 'Preserve planned shift']), expectedCycleHours: z.number().min(0).max(1000), status: z.enum(['Active', 'Draft']).optional() }),
  scheduleStatus: body({ status: z.enum(['Active', 'Draft', 'Retired']) }, withId),
  assign: body({ staffId: z.uuid(), scheduleId: z.uuid(), effectiveFrom: date, effectiveTo: date.optional(), captureMode: capture }),
  policy: body({ scope: text(120), effectiveFrom: date, effectiveTo: date.optional(), periodType: z.enum(['Weekly', 'Bi-weekly', 'Monthly']), captureDefault: capture, incrementMins: z.number().int().min(1).max(60), rounding: z.enum(['None', 'Nearest 5', 'Nearest 15']), submissionDeadlineDays: z.number().int().min(0).max(60), approvalDeadlineDays: z.number().int().min(0).max(60), lateGraceMins: z.number().int().min(0).max(240), earlyLeaveGraceMins: z.number().int().min(0).max(240), absenceThresholdMins: z.number().int().min(0).max(1440), maxDailyHours: z.number().int().min(1).max(24), allowEditDerived: z.boolean(), overtimeEnabled: z.boolean() }),
  settings: z.object({
    params: z.object(org).strict(), query: noQuery,
    body: z.object({
      capabilities: z.array(z.object({ key: z.enum(['Attendance', 'Scheduling', 'Timesheets']), enabled: z.boolean(), note: z.string().max(300) }).strict()).length(3).optional(),
      breakRules: z.array(z.object({ id: z.string().max(40), label: text(80), minShiftHours: hours, breakMins: z.number().int().min(0).max(600), paid: z.boolean(), autoDeduct: z.boolean() }).strict()).max(20).optional(),
      attendanceRules: z.array(z.object({ id: z.string().max(40), key: text(60), value: text(60), detail: z.string().max(300) }).strict()).max(30).optional(),
      enrolments: z.array(z.object({ id: z.string().max(40), selector: text(120), captureMode: capture, effectiveFrom: date, count: z.number().int().min(0), resolvedPolicy: z.string().max(120) }).strict()).max(100).optional(),
    }).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one setting'),
  }),
  holiday: body({ name: text(120), date, scope: z.enum(['Organisation', 'Location', 'Group', 'Schedule']), scopeValue: text(120), paid: z.boolean(), workRequiresApproval: z.boolean() }),
  empty: body({}, withId),
  clockIn: body({ employeeId: z.uuid().optional(), workLocation: z.enum(['WFO', 'WFH', 'Client Site']).optional(), location: text(120).optional(), source: z.enum(['Web', 'Mobile', 'Kiosk']).optional(), consent: z.boolean().optional() }),
  correct: body({ clockInAt: z.iso.datetime({ offset: true }).optional(), clockOutAt: z.iso.datetime({ offset: true }).nullable().optional(), breakMins: z.number().int().min(0).max(1440).optional() }, withId),
  resolve: body({ action: z.enum(['Acknowledged', 'Corrected', 'Excused', 'Escalated']), note: text(500).optional() }, withId),
  overtime: body({ employeeId: z.uuid().optional(), date, hours: z.number().positive().max(24), reason: text(500) }),
  leave: body({ employeeId: z.uuid().optional(), type: text(60), from: date, to: date, days: z.number().positive().max(366).optional(), paid: z.boolean().optional(), note: text(500).optional() }),
  holidayWork: body({ employeeId: z.uuid().optional(), holidayId: z.uuid(), reason: text(500), hours: z.number().positive().max(24) }),
  line: body({ date, workedHours: hours, expectedHours: hours.optional(), breakHours: hours.optional(), overtimeHours: hours.optional(), container: text(120).optional(), task: text(120).optional(), note: text(500).optional() }, withId),
  amendment: body({ timesheetId: z.uuid(), reason: text(500), change: text(1000) }),
  container: body({ label: text(40), name: text(120), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/), owner: text(120) }),
  task: body({ containerId: z.uuid(), name: text(160), parentId: z.uuid().optional(), assignedTo: text(120), estimateHours: z.number().min(0).max(100000).default(0) }),
  taskStatus: body({ status: z.enum(['Not started', 'In progress', 'Blocked', 'Done']) }, withId),
  activity: body({ taskId: z.uuid(), date, hours: z.number().positive().max(24), note: z.string().trim().max(500).optional(), staff: text(120).optional() }),
};

const SELF = ['workforce.self', 'workforce.manage'];
const APPROVE = ['workforce.self', 'workforce.approve']; // line managers hold workforce.self; the service checks the reporting line
const MANAGE = ['workforce.manage'];
const r = (method, path, schema, perms, fn, status = 200) => timeRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));

export const timeRoutes = express.Router({ mergeParams: true });
timeRoutes.get('/', check(v.overview), allow('workforce.self', 'workforce.approve', 'workforce.manage'), handle(async (req, res) => send(res, await time.overview(req.emr))));
r('post', '/blocks', v.block, MANAGE, (req) => time.addTimeBlock(req.emr, { name: req.body.name, code: req.body.code, startTime: req.body.start, endTime: req.body.end, overnight: req.body.overnight, paidHours: req.body.paidHours, breakMins: req.body.breakMins, lateGraceMins: req.body.lateGraceMins, classification: req.body.classification, colour: req.body.colour }), 201);
r('post', '/blocks/:id/active', v.blockActive, MANAGE, (req) => time.setTimeBlockActive(req.emr, req.params.id, req.body));
r('post', '/schedules', v.schedule, MANAGE, (req) => time.addSchedule(req.emr, req.body), 201);
r('post', '/schedules/:id/status', v.scheduleStatus, MANAGE, (req) => time.setScheduleStatus(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/assignments', v.assign, MANAGE, (req) => time.assignSchedule(req.emr, req.body), 201);
r('post', '/policies', v.policy, MANAGE, (req) => time.addPolicy(req.emr, req.body), 201);
timeRoutes.put('/settings', check(v.settings), allow(...MANAGE), handle(async (req, res) => send(res, await time.saveSettings(req.emr, requireVersion(req), req.body))));
r('post', '/holidays', v.holiday, MANAGE, (req) => time.addHoliday(req.emr, req.body), 201);
r('post', '/periods/:id/lock', v.empty, MANAGE, (req) => time.setPeriodLock(req.emr, req.params.id, requireVersion(req), true));
r('post', '/periods/:id/reopen', v.empty, MANAGE, (req) => time.setPeriodLock(req.emr, req.params.id, requireVersion(req), false));

r('post', '/attendance/clock-in', v.clockIn, SELF, (req) => time.clockIn(req.emr, req.body), 201);
r('post', '/attendance/:id/clock-out', v.empty, SELF, (req) => time.clockOut(req.emr, req.params.id));
r('post', '/attendance/:id/break-start', v.empty, SELF, (req) => time.startBreak(req.emr, req.params.id));
r('post', '/attendance/:id/break-end', v.empty, SELF, (req) => time.endBreak(req.emr, req.params.id));
r('post', '/attendance/:id/correct', v.correct, MANAGE, (req) => time.correctInterval(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/attendance/:id/resolve', v.resolve, APPROVE, (req) => time.resolveException(req.emr, req.params.id, requireVersion(req), req.body));

r('post', '/overtime', v.overtime, SELF, (req) => time.requestOvertime(req.emr, req.body), 201);
r('post', '/overtime/:id/decide', decision(['Approved', 'Rejected']), APPROVE, (req) => time.decideOvertime(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/leave', v.leave, SELF, (req) => time.requestLeave(req.emr, req.body), 201);
r('post', '/leave/:id/decide', decision(['Approved', 'Rejected']), APPROVE, (req) => time.decideLeave(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/holiday-work', v.holidayWork, SELF, (req) => time.requestHolidayWork(req.emr, req.body), 201);
r('post', '/holiday-work/:id/decide', decision(['Approved', 'Rejected']), APPROVE, (req) => time.decideHolidayWork(req.emr, req.params.id, requireVersion(req), req.body));

r('post', '/timesheets/:id/lines', v.line, SELF, (req) => time.addManualLine(req.emr, req.params.id, req.body), 201);
r('post', '/timesheets/:id/submit', v.empty, SELF, (req) => time.submitTimesheet(req.emr, req.params.id, requireVersion(req)));
r('post', '/timesheets/:id/recall', v.empty, SELF, (req) => time.recallTimesheet(req.emr, req.params.id, requireVersion(req)));
r('post', '/timesheets/:id/decide', decision(['Approved', 'Returned', 'Rejected']), APPROVE, (req) => time.decideTimesheet(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/amendments', v.amendment, SELF, (req) => time.requestAmendment(req.emr, req.body), 201);
r('post', '/amendments/:id/decide', decision(['Approved', 'Rejected']), APPROVE, (req) => time.decideAmendment(req.emr, req.params.id, requireVersion(req), req.body));

r('post', '/work/containers', v.container, MANAGE, (req) => time.addContainer(req.emr, req.body), 201);
r('post', '/work/tasks', v.task, ['workforce.manage', 'workforce.approve'], (req) => time.addTask(req.emr, req.body), 201);
r('post', '/work/tasks/:id/status', v.taskStatus, SELF, (req) => time.setTaskStatus(req.emr, req.params.id, requireVersion(req), req.body));
r('post', '/work/activities', v.activity, SELF, (req) => time.logActivity(req.emr, req.body), 201);
