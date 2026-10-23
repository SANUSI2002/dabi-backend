// Workforce time & attendance against real Postgres with RLS on: self-service clock in/out and breaks
// (one open interval), schedule-based flags, timesheets derived from attendance and frozen on submission,
// approval by HR or the line manager (never yourself), period lock and amendments, leave (no overlaps)
// and overtime flowing into the timesheet, work logging, and who sees whose records.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date());
const as = (who) => {
  const url = (path) => `/api/v1/workforce/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}, headers = {}) => request(app).post(url(path)).set('Authorization', who.auth).set(headers).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
    put: (path, body = {}, headers = {}) => request(app).put(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};

let A; let hr; let nurse; let doctor; let desk; let unlinked; let ids;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const time = async (who) => (await as(who).get('/time')).body.data;
const employeeOf = async (who) => (await as(hr).get('/people')).body.data.employees.find((e) => e.userId === who.userId);

beforeAll(async () => {
  A = await createTenant('wtA', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  nurse = await member(A, ['NURSE']);
  doctor = await member(A, ['DOCTOR']);
  desk = await member(A, ['RECEPTIONIST']);
  await as(hr).post('/people/employees/import-members');
  unlinked = await member(A, ['NURSE']); // joined after the import: no employee record yet
  const nurseEmp = await employeeOf(nurse);
  const doctorEmp = await employeeOf(doctor);
  await as(hr).patch(`/people/employees/${nurseEmp.id}`, { reportingManagerId: doctorEmp.id }, ifMatch(nurseEmp.version));
  ids = { nurse: nurseEmp.id, doctor: doctorEmp.id, desk: (await employeeOf(desk)).id };
});

describe('workforce time & attendance', () => {
  it('lets staff clock themselves in and out, with breaks and one open interval', async () => {
    expect((await as(unlinked).post('/time/attendance/clock-in', {})).body.error.code).toBe('NO_EMPLOYEE_RECORD');
    const inRes = await as(nurse).post('/time/attendance/clock-in', { workLocation: 'WFO', consent: true });
    expect(inRes.status, JSON.stringify(inRes.body)).toBe(201);
    expect(inRes.body.data.flags).toContain('Unscheduled');
    expect((await as(nurse).post('/time/attendance/clock-in', {})).body.error.code).toBe('ALREADY_CLOCKED_IN');
    const id = inRes.body.data.id;
    await as(nurse).post(`/time/attendance/${id}/break-start`);
    expect((await as(nurse).post(`/time/attendance/${id}/break-start`)).status).toBe(409);
    await as(nurse).post(`/time/attendance/${id}/break-end`);
    expect((await as(desk).post(`/time/attendance/${id}/clock-out`)).status).toBe(403); // not their record
    expect((await as(nurse).post(`/time/attendance/${id}/clock-out`)).status).toBe(200);
    const mine = (await time(nurse)).attendance.find((a) => a.id === id);
    expect(mine).toMatchObject({ staffId: ids.nurse, date: today(), clockIn: expect.stringMatching(/^\d\d:\d\d$/), clockOut: expect.stringMatching(/^\d\d:\d\d$/), breakMins: expect.any(Number) });
  });

  it('flags late arrival from the schedule', async () => {
    const block = (await as(hr).post('/time/blocks', { name: 'Day from midnight', code: 'MID', start: '00:00', end: '23:59', overnight: false, paidHours: 8, breakMins: 30, lateGraceMins: 0, classification: 'Working', colour: '#0fc06d' })).body.data;
    const all = Object.fromEntries(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => [d, block.id]));
    const schedule = (await as(hr).post('/time/schedules', { name: 'Every day', startDate: '2026-01-01', days: all, holidayRule: 'Preserve planned shift', expectedCycleHours: 56, status: 'Active' })).body.data;
    expect((await as(nurse).post('/time/blocks', { name: 'x', code: 'X', start: '08:00', end: '16:00', overnight: false, paidHours: 8, breakMins: 0, lateGraceMins: 0, classification: 'Working', colour: '#000' })).status).toBe(403);
    expect((await as(hr).post('/time/assignments', { staffId: ids.desk, scheduleId: schedule.id, effectiveFrom: '2026-01-01', captureMode: 'Attendance' })).status).toBe(201);
    const late = await as(desk).post('/time/attendance/clock-in', {});
    expect(late.body.data.flags).toContain('Late');
    await as(desk).post(`/time/attendance/${late.body.data.id}/clock-out`);
    const sheet = (await time(desk)).timesheets.find((t) => t.staffId === ids.desk);
    expect(sheet.lines.find((l) => l.source === 'Attendance' && l.date === today())).toMatchObject({ expectedHours: 8 });
  });

  it('runs a timesheet to approval, lock and amendment — never approved by its owner', async () => {
    let view = await time(nurse);
    let sheet = view.timesheets.find((t) => t.staffId === ids.nurse && t.periodId === view.currentPeriodId);
    expect(sheet).toMatchObject({ status: 'Open', version: 0 });
    expect(sheet.lines.some((l) => l.source === 'Attendance')).toBe(true);
    expect((await as(nurse).post(`/time/timesheets/${sheet.id}/lines`, { date: today(), workedHours: 1, note: 'Ward round handover' })).status).toBe(201);
    expect((await as(nurse).post(`/time/timesheets/${sheet.id}/submit`, {}, ifMatch(sheet.rowVersion))).body.data).toMatchObject({ status: 'Submitted', submission: 1 });
    sheet = (await time(nurse)).timesheets.find((t) => t.id === sheet.id);
    expect(sheet.lines.map((l) => l.source).sort()).toEqual(['Attendance', 'Manual']); // frozen
    expect((await as(nurse).post(`/time/timesheets/${sheet.id}/decide`, { status: 'Approved' }, ifMatch(sheet.rowVersion))).body.error.code).toBe('OWN_REQUEST');
    expect((await as(desk).post(`/time/timesheets/${sheet.id}/decide`, { status: 'Approved' }, ifMatch(sheet.rowVersion))).status).toBe(403);
    // The line manager (the doctor) may decide for a direct report.
    expect((await as(doctor).post(`/time/timesheets/${sheet.id}/decide`, { status: 'Approved' }, ifMatch(sheet.rowVersion))).body.data.status).toBe('Approved');
    view = await time(hr);
    const period = view.periods.find((p) => p.id === view.currentPeriodId);
    await as(hr).post(`/time/periods/${period.id}/lock`, {}, ifMatch(period.version));
    sheet = (await time(nurse)).timesheets.find((t) => t.id === sheet.id);
    expect(sheet).toMatchObject({ status: 'Locked', approver: expect.any(String), history: expect.arrayContaining([expect.objectContaining({ status: 'Locked', note: 'Period closed' })]) });
    expect((await as(nurse).post(`/time/timesheets/${sheet.id}/lines`, { date: today(), workedHours: 1 })).status).toBe(409);
    const amend = (await as(nurse).post('/time/amendments', { timesheetId: sheet.id, reason: 'Forgot night call', change: '+2h on call' })).body.data;
    expect((await as(hr).post(`/time/amendments/${amend.id}/decide`, { status: 'Approved' }, ifMatch(1))).status).toBe(200);
    sheet = (await time(nurse)).timesheets.find((t) => t.id === sheet.id);
    expect(sheet.history.at(-1).note).toBe('Amendment approved: +2h on call');
    await as(hr).post(`/time/periods/${period.id}/reopen`, {}, ifMatch(period.version + 1));
  });

  it('handles leave and overtime requests with the right deciders', async () => {
    const leave = await as(nurse).post('/time/leave', { type: 'Annual', from: '2026-12-21', to: '2026-12-24' });
    expect(leave.body.data.days).toBe(4);
    expect((await as(nurse).post('/time/leave', { type: 'Sick', from: '2026-12-24', to: '2026-12-26' })).body.error.code).toBe('LEAVE_OVERLAP');
    expect((await as(desk).post('/time/leave', { employeeId: ids.nurse, type: 'Annual', from: '2027-01-05', to: '2027-01-06' })).status).toBe(403);
    expect((await as(desk).post(`/time/leave/${leave.body.data.id}/decide`, { status: 'Approved' }, ifMatch(1))).status).toBe(403);
    expect((await as(doctor).post(`/time/leave/${leave.body.data.id}/decide`, { status: 'Approved' }, ifMatch(1))).body.data.status).toBe('Approved');
    expect((await as(doctor).post(`/time/leave/${leave.body.data.id}/decide`, { status: 'Rejected' }, ifMatch(2))).status).toBe(409);

    const ot = (await as(desk).post('/time/overtime', { date: today(), hours: 2, reason: 'Covered night desk' })).body.data;
    expect((await as(hr).post(`/time/overtime/${ot.id}/decide`, { status: 'Approved' }, ifMatch(1))).status).toBe(200);
    const sheet = (await time(desk)).timesheets.find((t) => t.staffId === ids.desk);
    expect(sheet.lines.find((l) => l.source === 'Attendance' && l.date === today()).overtimeHours).toBe(2);
  });

  it('logs work and keeps each person to their own records', async () => {
    const container = (await as(hr).post('/time/work/containers', { label: 'Programme', name: 'Malaria campaign', code: 'MAL26', owner: 'Public health' })).body.data;
    const task = (await as(hr).post('/time/work/tasks', { containerId: container.id, name: 'Bed-net distribution', assignedTo: 'Outreach team', estimateHours: 40 })).body.data;
    expect((await as(desk).post('/time/work/activities', { taskId: task.id, date: today(), hours: 3, note: 'Ward 3' })).status).toBe(201);
    expect((await time(hr)).tasks.find((t) => t.id === task.id).loggedHours).toBe(3);

    const deskView = await time(desk);
    expect(deskView.selfEmployeeId).toBe(ids.desk);
    expect(new Set(deskView.attendance.map((a) => a.staffId))).toEqual(new Set([ids.desk]));
    expect(deskView.leave).toEqual([]);
    const doctorView = await time(doctor);
    expect(doctorView.reportIds).toEqual([ids.nurse]);
    expect(doctorView.leave.map((l) => l.staffId)).toEqual([ids.nurse]);
    expect((await time(hr)).seesEveryone).toBe(true);
    const dir = (await as(desk).get('/people/directory')).body.data;
    expect(dir.employees.find((e) => e.id === ids.nurse)).toEqual(expect.objectContaining({ name: expect.any(String), role: 'Nurse', reportingManagerId: ids.doctor }));
    expect(dir.employees[0].accountNumber).toBeUndefined();
    expect((await as(desk).get('/people')).status).toBe(403);
  });
});
