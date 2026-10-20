// Workforce time & attendance and work.
//
// Who sees and does what (enforced here, not only in the screen):
//   - everyone with workforce.self acts for themselves (their linked employee record);
//   - a line manager (an employee others report to) also sees and decides for their direct reports;
//   - workforce.approve sees everyone and decides for anyone; workforce.manage configures and corrects;
//   - nobody decides their own request.
// Attendance: one open interval per employee; flags (Late, Overnight, Corrected…) are set by the server
// from the employee's schedule. Timesheets: one per employee and period; while Open/Returned their
// attendance lines are derived from attendance on every read, and on submission those lines are frozen
// with a new submission number and an event. Locking a period locks its approved sheets; after that
// only amendments (addenda) are possible. Times are shown in the organization's time zone.
import { withTenant } from '../../emr/core/db.js';
import { recordAudit } from '../../emr/core/audit.js';
import { updateVersioned } from '../../emr/core/concurrency.js';
import { EmrError, uniqueViolation } from '../../emr/core/errors.js';
import { userNameMap } from '../../emr/core/people.js';

const TZ = process.env.WORKFORCE_TIME_ZONE || 'Africa/Lagos';
const DAY = 86_400_000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const round2 = (n) => Math.round(n * 100) / 100;
const isoDay = (value) => (value ? value.toISOString().slice(0, 10) : null);
const toDate = (iso) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
const org = (context) => ({ organizationId: context.organizationId });
const localParts = (date) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export const DEFAULT_SETTINGS = {
  capabilities: [
    { key: 'Attendance', enabled: true, note: 'Check-in, check-out, breaks, correction and exception handling.' },
    { key: 'Scheduling', enabled: true, note: 'Time blocks, weekly schedules, assignments and expected hours.' },
    { key: 'Timesheets', enabled: true, note: 'Periods, manual or derived lines, submission and approval.' },
  ],
  breakRules: [
    { id: 'br1', label: 'Short shift', minShiftHours: 0, breakMins: 0, paid: false, autoDeduct: false },
    { id: 'br2', label: 'Standard day', minShiftHours: 6, breakMins: 30, paid: false, autoDeduct: true },
  ],
  attendanceRules: [
    { id: 'ar1', key: 'Late grace', value: 'From the time block', detail: 'Clock-in within the block\'s grace is not flagged Late.' },
    { id: 'ar2', key: 'One open interval', value: 'Enforced', detail: 'A second clock-in is refused until the open one is closed.' },
  ],
  enrolments: [],
};
const DEFAULT_POLICY = {
  scope: 'Organisation default', periodType: 'Monthly', captureDefault: 'Attendance', incrementMins: 15, rounding: 'None', submissionDeadlineDays: 3, approvalDeadlineDays: 5,
  lateGraceMins: 10, earlyLeaveGraceMins: 10, absenceThresholdMins: 240, maxDailyHours: 16, allowEditDerived: false, overtimeEnabled: true,
};

// ---- who is acting ----------------------------------------------------------------------------------
async function actor(tx, context) {
  const self = await tx.wfEmployee.findFirst({ where: { ...org(context), userId: context.userId }, select: { id: true, name: true } });
  const all = context.permissions.includes('workforce.approve') || context.permissions.includes('workforce.manage');
  const reports = self ? (await tx.wfEmployee.findMany({ where: { ...org(context), reportingManagerId: self.id }, select: { id: true } })).map((e) => e.id) : [];
  const visible = all ? null : [...(self ? [self.id] : []), ...reports];
  return {
    self, all, reports,
    visible, // null = everyone
    sees: (employeeId) => visible === null || visible.includes(employeeId),
    decides: (employeeId) => employeeId !== self?.id && (context.permissions.includes('workforce.approve') || reports.includes(employeeId)),
  };
}
/** The employee an action is for: yourself unless you manage them (or are a workforce manager). */
async function forEmployee(tx, context, who, employeeId) {
  const id = employeeId ?? who.self?.id;
  if (!id) throw new EmrError('NO_EMPLOYEE_RECORD');
  if (id !== who.self?.id && !who.all && !who.reports.includes(id)) throw new EmrError('PERMISSION_DENIED');
  const employee = await tx.wfEmployee.findFirst({ where: { ...org(context), id }, select: { id: true, status: true, name: true } });
  if (!employee) throw new EmrError('EMPLOYEE_NOT_FOUND');
  if (employee.status !== 'ACTIVE') throw new EmrError('INVALID_STATE', { message: `${employee.name} is not an active employee.` });
  return employee;
}
const requireDecider = (who, employeeId) => {
  if (employeeId === who.self?.id) throw new EmrError('OWN_REQUEST');
  if (!who.decides(employeeId)) throw new EmrError('PERMISSION_DENIED');
};

// ---- schedules: the expected block on a day ---------------------------------------------------------
function blockFor(day, assignments, schedules, blocks) {
  const date = toDate(day);
  const assignment = assignments.find((a) => a.effectiveFrom <= date && (!a.effectiveTo || a.effectiveTo >= date));
  if (!assignment) return null;
  const schedule = schedules.find((s) => s.id === assignment.scheduleId && s.status !== 'Retired');
  if (!schedule) return null;
  let ref;
  if (schedule.rotation?.length) {
    const anchor = schedule.rotationAnchor ?? schedule.startDate;
    const index = Math.floor((date - anchor) / DAY);
    ref = schedule.rotation[((index % schedule.rotation.length) + schedule.rotation.length) % schedule.rotation.length];
  } else {
    ref = schedule.days?.[DAYS[date.getUTCDay()]];
  }
  if (!ref || ref === 'Off') return null;
  return blocks.find((b) => b.id === ref) ?? null;
}

// ---- periods --------------------------------------------------------------------------------------
function periodBounds(type, today) {
  const d = toDate(today);
  if (type === 'Monthly') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { start, end, label: start.toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' }) };
  }
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY);
  if (type === 'Weekly') return { start: monday, end: new Date(monday.getTime() + 6 * DAY), label: `Week of ${isoDay(monday)}` };
  // Bi-weekly: fortnights counted from the first Monday of 2024.
  const epoch = Date.UTC(2024, 0, 1);
  const fortnight = Math.floor((monday.getTime() - epoch) / (14 * DAY));
  const start = new Date(epoch + fortnight * 14 * DAY);
  return { start, end: new Date(start.getTime() + 13 * DAY), label: `Fortnight of ${isoDay(start)}` };
}
async function currentPolicy(tx, context) {
  const today = toDate(localParts(new Date()).day);
  const policies = await tx.wfTimePolicy.findMany({ where: { ...org(context), effectiveFrom: { lte: today } }, orderBy: { effectiveFrom: 'desc' } });
  return policies.find((p) => !p.effectiveTo || p.effectiveTo >= today) ?? null;
}
async function ensureCurrentPeriod(tx, context) {
  const policy = await currentPolicy(tx, context);
  const bounds = periodBounds(policy?.periodType ?? DEFAULT_POLICY.periodType, localParts(new Date()).day);
  const existing = await tx.wfPeriod.findFirst({ where: { ...org(context), startDate: bounds.start } });
  if (existing) return existing;
  try {
    return await tx.wfPeriod.create({ data: { ...org(context), label: bounds.label, startDate: bounds.start, endDate: bounds.end } });
  } catch (error) {
    if (uniqueViolation(error, { start: 'X' })) return tx.wfPeriod.findFirst({ where: { ...org(context), startDate: bounds.start } });
    throw error;
  }
}
async function ensureSettings(tx, context) {
  const row = await tx.wfSettings.findUnique({ where: { organizationId: context.organizationId } });
  if (row) return row;
  return tx.wfSettings.create({ data: { ...org(context), ...DEFAULT_SETTINGS } });
}

// ---- timesheet lines --------------------------------------------------------------------------------
function attendanceLines(intervals, period, assignments, schedules, blocks, overtime) {
  const byDay = new Map();
  for (const a of intervals) {
    if (!a.clockOutAt) continue;
    const day = localParts(a.clockInAt).day;
    if (day < isoDay(period.startDate) || day > isoDay(period.endDate)) continue;
    const entry = byDay.get(day) ?? { worked: 0, breaks: 0 };
    entry.worked += Math.max(0, (a.clockOutAt - a.clockInAt) / 3_600_000 - a.breakMins / 60);
    entry.breaks += a.breakMins / 60;
    byDay.set(day, entry);
  }
  return [...byDay.entries()].sort().map(([day, e]) => ({
    id: `derived-${day}`, date: day, source: 'Attendance', expectedHours: num(blockFor(day, assignments, schedules, blocks)?.paidHours),
    workedHours: round2(e.worked), breakHours: round2(e.breaks),
    overtimeHours: round2(overtime.filter((o) => isoDay(o.workDate) === day).reduce((n, o) => n + num(o.hours), 0)),
  }));
}
const presentLine = (l) => ({ id: l.id, date: isoDay(l.workDate), source: l.source, expectedHours: num(l.expectedHours), workedHours: num(l.workedHours), breakHours: num(l.breakHours), overtimeHours: num(l.overtimeHours), container: l.container ?? undefined, task: l.task ?? undefined, note: l.note ?? undefined });

// ---- overview -----------------------------------------------------------------------------------------
export async function overview(context) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const period = await ensureCurrentPeriod(tx, context);
    const settings = await ensureSettings(tx, context);
    if (!await tx.wfTimePolicy.count({ where: org(context) })) {
      await tx.wfTimePolicy.create({ data: { ...org(context), ...DEFAULT_POLICY, effectiveFrom: period.startDate, createdByUserId: context.userId } });
    }
    const scope = who.visible === null ? {} : { employeeId: { in: who.visible } };
    const since = new Date(Date.now() - 62 * DAY);
    // Every active employee in view has a timesheet for the current period.
    const employees = await tx.wfEmployee.findMany({ where: { ...org(context), status: 'ACTIVE', ...(who.visible === null ? {} : { id: { in: who.visible } }) }, select: { id: true } });
    const have = new Set((await tx.wfTimesheet.findMany({ where: { ...org(context), periodId: period.id }, select: { employeeId: true } })).map((t) => t.employeeId));
    const missing = employees.filter((e) => !have.has(e.id));
    if (missing.length) await tx.wfTimesheet.createMany({ data: missing.map((e) => ({ ...org(context), employeeId: e.id, periodId: period.id })), skipDuplicates: true });

    const where = org(context);
    const [blocks, schedules, assignments, attendance, periods, timesheets, policies, holidays, leave, holidayWork, overtime, amendments, containers, tasks, activities] = await Promise.all([
      tx.wfTimeBlock.findMany({ where, orderBy: { code: 'asc' } }),
      tx.wfSchedule.findMany({ where, orderBy: { createdAt: 'desc' } }),
      tx.wfScheduleAssignment.findMany({ where: { ...where, ...scope }, orderBy: { effectiveFrom: 'desc' } }),
      tx.wfAttendance.findMany({ where: { ...where, ...scope, clockInAt: { gte: since } }, orderBy: { clockInAt: 'desc' } }),
      tx.wfPeriod.findMany({ where, orderBy: { startDate: 'desc' }, take: 24 }),
      tx.wfTimesheet.findMany({ where: { ...where, ...scope }, include: { lines: { orderBy: { workDate: 'asc' } }, events: { orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 1000 }),
      tx.wfTimePolicy.findMany({ where, orderBy: { effectiveFrom: 'desc' } }),
      tx.wfHoliday.findMany({ where, orderBy: { holidayDate: 'asc' } }),
      tx.wfLeaveRequest.findMany({ where: { ...where, ...scope }, orderBy: { createdAt: 'desc' } }),
      tx.wfHolidayWorkRequest.findMany({ where: { ...where, ...scope }, orderBy: { createdAt: 'desc' } }),
      tx.wfOvertimeRequest.findMany({ where: { ...where, ...scope }, orderBy: { createdAt: 'desc' } }),
      tx.wfAmendment.findMany({ where, orderBy: { createdAt: 'desc' } }),
      tx.wfWorkContainer.findMany({ where, orderBy: { name: 'asc' } }),
      tx.wfWorkTask.findMany({ where, orderBy: { createdAt: 'asc' } }),
      tx.wfWorkActivity.findMany({ where, orderBy: { workDate: 'desc' }, take: 2000 }),
    ]);
    const visibleSheets = new Set(timesheets.map((t) => t.id));
    const names = await userNameMap(tx, [
      ...timesheets.flatMap((t) => [t.approverUserId, ...t.events.map((e) => e.byUserId)]), ...attendance.map((a) => a.resolutionByUserId),
      ...overtime.map((o) => o.decidedByUserId), ...amendments.flatMap((a) => [a.requestedByUserId, a.decidedByUserId]), ...periods.map((p) => p.lockedByUserId),
    ].filter(Boolean));
    const name = (id) => (id ? names.get(id) ?? 'Unknown staff member' : undefined);
    const today = localParts(new Date()).day;
    const todayLeave = new Set(leave.filter((l) => l.status === 'Approved' && isoDay(l.fromDate) <= today && isoDay(l.toDate) >= today).map((l) => l.employeeId));
    await recordAudit(tx, context, { action: 'time.viewed', resourceType: 'time' });
    return {
      selfEmployeeId: who.self?.id ?? null, reportIds: who.reports, seesEveryone: who.all, currentPeriodId: period.id, timeZone: TZ, onLeaveToday: [...todayLeave],
      timeBlocks: blocks.map((b) => ({ id: b.id, name: b.name, code: b.code, start: b.startTime, end: b.endTime, overnight: b.overnight, paidHours: num(b.paidHours), breakMins: b.breakMins, lateGraceMins: b.lateGraceMins, classification: b.classification, colour: b.colour, active: b.active })),
      schedules: schedules.map((s) => ({ id: s.id, name: s.name, description: s.description ?? undefined, startDate: isoDay(s.startDate), endDate: isoDay(s.endDate) ?? undefined, days: s.days, rotation: s.rotation.length ? s.rotation : undefined, rotationLength: s.rotation.length || undefined, rotationAnchor: isoDay(s.rotationAnchor) ?? undefined, holidayRule: s.holidayRule, expectedCycleHours: num(s.expectedCycleHours), status: s.status, version: s.version })),
      assignments: assignments.map((a) => ({ id: a.id, staffId: a.employeeId, scheduleId: a.scheduleId, effectiveFrom: isoDay(a.effectiveFrom), effectiveTo: isoDay(a.effectiveTo) ?? undefined, captureMode: a.captureMode })),
      attendance: attendance.map((a) => ({
        id: a.id, staffId: a.employeeId, clockInAt: a.clockInAt, clockOutAt: a.clockOutAt, date: localParts(a.clockInAt).day, clockIn: localParts(a.clockInAt).time, clockOut: a.clockOutAt ? localParts(a.clockOutAt).time : undefined,
        source: a.source, breakMins: a.breakMins, onBreakSince: a.onBreakSince ?? undefined, flags: [...a.flags, ...(!a.clockOutAt && localParts(a.clockInAt).day < today ? ['Missing checkout'] : []), ...(a.onBreakSince ? ['On break'] : [])],
        location: a.location ?? undefined, workLocation: a.workLocation, consentAt: a.consentAt ?? undefined, version: a.version,
        exceptionResolution: a.resolutionAction ? { action: a.resolutionAction, by: name(a.resolutionByUserId), at: a.resolutionAt, note: a.resolutionNote ?? undefined } : undefined,
      })),
      periods: periods.map((p) => ({ id: p.id, label: p.label, start: isoDay(p.startDate), end: isoDay(p.endDate), locked: p.locked, lockedBy: name(p.lockedByUserId), lockedAt: p.lockedAt ?? undefined, version: p.version })),
      timesheets: timesheets.map((t) => {
        const p = periods.find((x) => x.id === t.periodId) ?? period;
        const open = ['Open', 'Returned'].includes(t.status);
        const own = (list) => list.filter((x) => x.employeeId === t.employeeId);
        const derived = open && t.captureMode !== 'Manual'
          ? attendanceLines(own(attendance), p, own(assignments), schedules, blocks, own(overtime).filter((o) => o.status === 'Approved'))
          : [];
        const stored = t.lines.filter((l) => !open || l.source === 'Manual').map(presentLine);
        return {
          id: t.id, staffId: t.employeeId, periodId: t.periodId, status: t.status, captureMode: t.captureMode, version: t.submission, rowVersion: t.version,
          lines: [...derived, ...stored].sort((a, b) => a.date.localeCompare(b.date)), submittedAt: t.submittedAt ?? undefined, approvedAt: t.approvedAt ?? undefined,
          approver: name(t.approverUserId), returnNote: t.returnNote ?? undefined,
          history: t.events.map((e) => ({ version: e.submission, status: e.status, at: e.createdAt, by: name(e.byUserId), note: e.note ?? undefined })),
        };
      }),
      policies: policies.map((p) => {
        const current = p.effectiveFrom <= toDate(today) && (!p.effectiveTo || p.effectiveTo >= toDate(today));
        return { id: p.id, scope: p.scope, effectiveFrom: isoDay(p.effectiveFrom), effectiveTo: isoDay(p.effectiveTo) ?? undefined, periodType: p.periodType, captureDefault: p.captureDefault, incrementMins: p.incrementMins, rounding: p.rounding, submissionDeadlineDays: p.submissionDeadlineDays, approvalDeadlineDays: p.approvalDeadlineDays, lateGraceMins: p.lateGraceMins, earlyLeaveGraceMins: p.earlyLeaveGraceMins, absenceThresholdMins: p.absenceThresholdMins, maxDailyHours: p.maxDailyHours, allowEditDerived: p.allowEditDerived, overtimeEnabled: p.overtimeEnabled, status: current ? 'Current' : p.effectiveFrom > toDate(today) ? 'Future' : 'Expired' };
      }),
      settings: { capabilities: settings.capabilities, breakRules: settings.breakRules, attendanceRules: settings.attendanceRules, enrolments: settings.enrolments, version: settings.version },
      holidays: holidays.map((h) => ({ id: h.id, name: h.name, date: isoDay(h.holidayDate), scope: h.scope, scopeValue: h.scopeValue, paid: h.paid, workRequiresApproval: h.workRequiresApproval })),
      leave: leave.map((l) => ({ id: l.id, staffId: l.employeeId, type: l.leaveType, from: isoDay(l.fromDate), to: isoDay(l.toDate), days: num(l.days), status: l.status, paid: l.paid, note: l.note ?? undefined, version: l.version })),
      holidayWork: holidayWork.map((h) => ({ id: h.id, staffId: h.employeeId, holidayId: h.holidayId, reason: h.reason, status: h.status, hours: num(h.hours), version: h.version })),
      overtime: overtime.map((o) => ({ id: o.id, staffId: o.employeeId, date: isoDay(o.workDate), hours: num(o.hours), reason: o.reason, status: o.status, requestedAt: o.createdAt, decidedBy: name(o.decidedByUserId), decidedAt: o.decidedAt ?? undefined, decisionNote: o.decisionNote ?? undefined, version: o.version })),
      amendments: amendments.filter((a) => visibleSheets.has(a.timesheetId)).map((a) => {
        const t = timesheets.find((x) => x.id === a.timesheetId);
        return { id: a.id, timesheetId: a.timesheetId, periodId: t?.periodId, staffId: t?.employeeId, requestedBy: name(a.requestedByUserId), requestedAt: a.createdAt, reason: a.reason, change: a.change, status: a.status, decidedBy: name(a.decidedByUserId), decidedAt: a.decidedAt ?? undefined, decisionNote: a.decisionNote ?? undefined, version: a.version };
      }),
      containers: containers.map((c) => ({ id: c.id, label: c.label, name: c.name, code: c.code, owner: c.owner, status: c.status })),
      tasks: tasks.map((t) => ({ id: t.id, containerId: t.containerId, name: t.name, parentId: t.parentId ?? undefined, assignedTo: t.assignedTo, status: t.status, estimateHours: num(t.estimateHours), loggedHours: round2(activities.filter((a) => a.taskId === t.id).reduce((n, a) => n + num(a.hours), 0)), version: t.version })),
      activities: activities.map((a) => ({ id: a.id, taskId: a.taskId, staff: a.staff, date: isoDay(a.workDate), hours: num(a.hours), note: a.note })),
    };
  });
}

// ---- configuration (workforce.manage) ---------------------------------------------------------------
const audited = async (tx, context, action, resourceType, resourceId) => recordAudit(tx, context, { action, resourceType, resourceId });

export async function addTimeBlock(context, input) {
  return withTenant(context, async (tx) => {
    try {
      const row = await tx.wfTimeBlock.create({ data: { ...org(context), ...input } });
      await audited(tx, context, 'time_block.created', 'time_block', row.id);
      return { id: row.id };
    } catch (error) { throw uniqueViolation(error, { code: 'HR_CODE_IN_USE' }) ?? error; }
  });
}
export async function setTimeBlockActive(context, id, { active }) {
  return withTenant(context, async (tx) => {
    const { count } = await tx.wfTimeBlock.updateMany({ where: { ...org(context), id }, data: { active } });
    if (!count) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    await audited(tx, context, active ? 'time_block.activated' : 'time_block.retired', 'time_block', id);
    return { id, active };
  });
}
async function checkBlocks(tx, context, refs) {
  const ids = [...new Set(refs.filter((r) => r && r !== 'Off'))];
  if (ids.length && await tx.wfTimeBlock.count({ where: { ...org(context), id: { in: ids } } }) !== ids.length) throw new EmrError('VALIDATION_FAILED', { message: 'The schedule names a time block that does not exist.' });
}
export async function addSchedule(context, input) {
  return withTenant(context, async (tx) => {
    await checkBlocks(tx, context, [...Object.values(input.days), ...(input.rotation ?? [])]);
    const row = await tx.wfSchedule.create({
      data: { ...org(context), ...(input.id ? { id: input.id } : {}), name: input.name, description: input.description ?? null, startDate: toDate(input.startDate), endDate: toDate(input.endDate), days: input.days, rotation: input.rotation ?? [], rotationAnchor: toDate(input.rotationAnchor), holidayRule: input.holidayRule, expectedCycleHours: input.expectedCycleHours, status: input.status ?? 'Draft' },
    });
    await audited(tx, context, 'schedule.created', 'schedule', row.id);
    return { id: row.id };
  });
}
export async function setScheduleStatus(context, id, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    await updateVersioned(tx.wfSchedule, { organizationId: context.organizationId, id, expectedVersion, data: { status }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    await audited(tx, context, `schedule.${status.toLowerCase()}`, 'schedule', id);
    return { id, status };
  });
}
export async function assignSchedule(context, input) {
  return withTenant(context, async (tx) => {
    if (!await tx.wfEmployee.count({ where: { ...org(context), id: input.staffId } })) throw new EmrError('EMPLOYEE_NOT_FOUND');
    const schedule = await tx.wfSchedule.findFirst({ where: { ...org(context), id: input.scheduleId } });
    if (!schedule) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    if (schedule.status === 'Retired') throw new EmrError('INVALID_STATE', { message: 'This schedule is retired.' });
    // A new assignment ends the employee's open one the day before it starts.
    const from = toDate(input.effectiveFrom);
    await tx.wfScheduleAssignment.updateMany({ where: { ...org(context), employeeId: input.staffId, effectiveFrom: { lt: from }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: from } }] }, data: { effectiveTo: new Date(from.getTime() - DAY) } });
    if (await tx.wfScheduleAssignment.count({ where: { ...org(context), employeeId: input.staffId, effectiveFrom: { gte: from } } })) throw new EmrError('INVALID_STATE', { message: 'This employee already has an assignment starting on or after that date.' });
    const row = await tx.wfScheduleAssignment.create({ data: { ...org(context), employeeId: input.staffId, scheduleId: input.scheduleId, effectiveFrom: from, effectiveTo: toDate(input.effectiveTo), captureMode: input.captureMode, assignedByUserId: context.userId } });
    await audited(tx, context, 'schedule.assigned', 'employee', input.staffId);
    return { id: row.id };
  });
}
export async function addPolicy(context, input) {
  return withTenant(context, async (tx) => {
    const row = await tx.wfTimePolicy.create({ data: { ...org(context), ...input, effectiveFrom: toDate(input.effectiveFrom), effectiveTo: toDate(input.effectiveTo), createdByUserId: context.userId } });
    await audited(tx, context, 'time_policy.created', 'time_policy', row.id);
    return { id: row.id };
  });
}
export async function saveSettings(context, expectedVersion, patch) {
  return withTenant(context, async (tx) => {
    await ensureSettings(tx, context);
    const { count } = await tx.wfSettings.updateMany({ where: { ...org(context), version: expectedVersion }, data: { ...patch, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() } });
    if (count !== 1) throw new EmrError('VERSION_CONFLICT');
    await audited(tx, context, 'time_settings.updated', 'time_settings');
    return { saved: true };
  });
}
export async function addHoliday(context, input) {
  return withTenant(context, async (tx) => {
    const row = await tx.wfHoliday.create({ data: { ...org(context), name: input.name, holidayDate: toDate(input.date), scope: input.scope, scopeValue: input.scopeValue, paid: input.paid, workRequiresApproval: input.workRequiresApproval } });
    await audited(tx, context, 'holiday.created', 'holiday', row.id);
    return { id: row.id };
  });
}
export async function setPeriodLock(context, periodId, expectedVersion, lock) {
  return withTenant(context, async (tx) => {
    const period = await tx.wfPeriod.findFirst({ where: { ...org(context), id: periodId } });
    if (!period) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    if (period.locked === lock) throw new EmrError('INVALID_STATE', { message: lock ? 'This period is already locked.' : 'This period is not locked.' });
    await updateVersioned(tx.wfPeriod, { organizationId: context.organizationId, id: periodId, expectedVersion, data: lock ? { locked: true, lockedByUserId: context.userId, lockedAt: new Date() } : { locked: false, lockedByUserId: null, lockedAt: null }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    if (lock) {
      const approved = await tx.wfTimesheet.findMany({ where: { ...org(context), periodId, status: 'Approved' }, select: { id: true, submission: true } });
      for (const t of approved) {
        await tx.wfTimesheet.updateMany({ where: { ...org(context), id: t.id }, data: { status: 'Locked', version: { increment: 1 } } });
        await tx.wfTimesheetEvent.create({ data: { ...org(context), timesheetId: t.id, submission: t.submission, status: 'Locked', byUserId: context.userId, note: 'Period closed' } });
      }
    }
    await audited(tx, context, lock ? 'period.locked' : 'period.reopened', 'period', periodId);
    return { id: periodId, locked: lock };
  });
}

// ---- attendance -----------------------------------------------------------------------------------
async function scheduleContext(tx, context, employeeId) {
  const [assignments, schedules, blocks] = await Promise.all([
    tx.wfScheduleAssignment.findMany({ where: { ...org(context), employeeId } }), tx.wfSchedule.findMany({ where: org(context) }), tx.wfTimeBlock.findMany({ where: org(context) }),
  ]);
  return { assignments, schedules, blocks };
}
export async function clockIn(context, input) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const employee = await forEmployee(tx, context, who, input.employeeId);
    const now = new Date();
    const { day, time } = localParts(now);
    const { assignments, schedules, blocks } = await scheduleContext(tx, context, employee.id);
    const block = blockFor(day, assignments, schedules, blocks);
    const flags = [];
    if (block && block.classification === 'Working' && minutesOf(time) > minutesOf(block.startTime) + block.lateGraceMins && !block.overnight) flags.push('Late');
    if (!block) flags.push('Unscheduled');
    let row;
    try {
      row = await tx.wfAttendance.create({
        data: { ...org(context), employeeId: employee.id, clockInAt: now, source: input.source ?? 'Web', flags, location: input.location ?? null, workLocation: input.workLocation ?? 'WFO', consentAt: input.consent ? now : null, recordedByUserId: context.userId },
      });
    } catch (error) {
      throw uniqueViolation(error, { one_open: 'ALREADY_CLOCKED_IN' }) ?? error;
    }
    await audited(tx, context, 'attendance.clocked_in', 'employee', employee.id);
    return { id: row.id, flags };
  });
}
async function ownInterval(tx, context, who, id) {
  const a = await tx.wfAttendance.findFirst({ where: { ...org(context), id } });
  if (!a) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
  if (a.employeeId !== who.self?.id && !who.all && !who.reports.includes(a.employeeId)) throw new EmrError('PERMISSION_DENIED');
  return a;
}
async function changeInterval(tx, a, data) {
  const { count } = await tx.wfAttendance.updateMany({ where: { organizationId: a.organizationId, id: a.id, version: a.version }, data: { ...data, version: { increment: 1 } } });
  if (count !== 1) throw new EmrError('VERSION_CONFLICT');
}
export async function clockOut(context, id) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const a = await ownInterval(tx, context, who, id);
    if (a.clockOutAt) throw new EmrError('NOT_CLOCKED_IN');
    const now = new Date(Math.max(Date.now(), a.clockInAt.getTime() + 1)); // strictly after clock-in
    const extra = a.onBreakSince ? Math.max(0, Math.round((now - a.onBreakSince) / 60000)) : 0;
    const flags = [...new Set([...a.flags, ...(localParts(now).day !== localParts(a.clockInAt).day ? ['Overnight'] : [])])];
    await changeInterval(tx, a, { clockOutAt: now, breakMins: a.breakMins + extra, onBreakSince: null, flags });
    await audited(tx, context, 'attendance.clocked_out', 'employee', a.employeeId);
    return { id, clockOutAt: now };
  });
}
export async function startBreak(context, id) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const a = await ownInterval(tx, context, who, id);
    if (a.clockOutAt || a.onBreakSince) throw new EmrError('INVALID_STATE', { message: a.clockOutAt ? 'This attendance is closed.' : 'A break is already running.' });
    await changeInterval(tx, a, { onBreakSince: new Date() });
    return { id };
  });
}
export async function endBreak(context, id) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const a = await ownInterval(tx, context, who, id);
    if (!a.onBreakSince) throw new EmrError('INVALID_STATE', { message: 'No break is running.' });
    await changeInterval(tx, a, { breakMins: a.breakMins + Math.max(1, Math.round((Date.now() - a.onBreakSince) / 60000)), onBreakSince: null });
    return { id };
  });
}
/** A manager's correction of the times (the original is kept in the audit trail; the row is flagged). */
export async function correctInterval(context, id, expectedVersion, input) {
  return withTenant(context, async (tx) => {
    const a = await tx.wfAttendance.findFirst({ where: { ...org(context), id } });
    if (!a) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    const clockInAt = input.clockInAt ? new Date(input.clockInAt) : a.clockInAt;
    const clockOutAt = input.clockOutAt === null ? null : input.clockOutAt ? new Date(input.clockOutAt) : a.clockOutAt;
    if (clockOutAt && clockOutAt <= clockInAt) throw new EmrError('VALIDATION_FAILED', { message: 'Clock-out must be after clock-in.' });
    if (clockInAt > new Date() || (clockOutAt && clockOutAt > new Date())) throw new EmrError('VALIDATION_FAILED', { message: 'Times cannot be in the future.' });
    const { count } = await tx.wfAttendance.updateMany({
      where: { ...org(context), id, version: expectedVersion },
      data: { clockInAt, clockOutAt, ...(input.breakMins !== undefined ? { breakMins: input.breakMins } : {}), onBreakSince: clockOutAt ? null : a.onBreakSince, flags: [...new Set([...a.flags.filter((f) => f !== 'Late'), 'Corrected'])], version: { increment: 1 } },
    });
    if (count !== 1) throw new EmrError('VERSION_CONFLICT');
    await recordAudit(tx, context, { action: 'attendance.corrected', resourceType: 'employee', resourceId: a.employeeId, changedFields: Object.keys(input) });
    return { id };
  });
}
export async function resolveException(context, id, expectedVersion, { action, note }) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const a = await tx.wfAttendance.findFirst({ where: { ...org(context), id } });
    if (!a) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    requireDecider(who, a.employeeId);
    const { count } = await tx.wfAttendance.updateMany({ where: { ...org(context), id, version: expectedVersion }, data: { resolutionAction: action, resolutionByUserId: context.userId, resolutionAt: new Date(), resolutionNote: note ?? null, flags: [...new Set([...a.flags, 'Reviewed'])], version: { increment: 1 } } });
    if (count !== 1) throw new EmrError('VERSION_CONFLICT');
    await audited(tx, context, `attendance.exception_${action.toLowerCase()}`, 'employee', a.employeeId);
    return { id, action };
  });
}

// ---- requests: overtime, leave, holiday work --------------------------------------------------------
export async function requestOvertime(context, input) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const employee = await forEmployee(tx, context, who, input.employeeId);
    if (input.date > localParts(new Date()).day) throw new EmrError('VALIDATION_FAILED', { message: 'Overtime is claimed for time already worked.' });
    const row = await tx.wfOvertimeRequest.create({ data: { ...org(context), employeeId: employee.id, workDate: toDate(input.date), hours: input.hours, reason: input.reason, requestedByUserId: context.userId } });
    await audited(tx, context, 'overtime.requested', 'employee', employee.id);
    return { id: row.id };
  });
}
async function decide(tx, context, model, id, expectedVersion, status, extra = {}) {
  const who = await actor(tx, context);
  const row = await model.findFirst({ where: { ...org(context), id } });
  if (!row) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
  requireDecider(who, row.employeeId);
  if (row.status !== 'Pending') throw new EmrError('INVALID_STATE', { message: 'This request has already been decided.' });
  await updateVersioned(model, { organizationId: context.organizationId, id, expectedVersion, data: { status, decidedByUserId: context.userId, decidedAt: new Date(), ...extra }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
  return row;
}
export async function decideOvertime(context, id, expectedVersion, { status, note }) {
  return withTenant(context, async (tx) => {
    const row = await decide(tx, context, tx.wfOvertimeRequest, id, expectedVersion, status, { decisionNote: note ?? null });
    await audited(tx, context, `overtime.${status.toLowerCase()}`, 'employee', row.employeeId);
    return { id, status };
  });
}
export async function requestLeave(context, input) {
  if (input.to < input.from) throw new EmrError('VALIDATION_FAILED', { message: 'The leave must end on or after its first day.' });
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const employee = await forEmployee(tx, context, who, input.employeeId);
    const overlap = await tx.wfLeaveRequest.count({ where: { ...org(context), employeeId: employee.id, status: { in: ['Pending', 'Approved'] }, fromDate: { lte: toDate(input.to) }, toDate: { gte: toDate(input.from) } } });
    if (overlap) throw new EmrError('LEAVE_OVERLAP');
    const days = input.days ?? Math.round((toDate(input.to) - toDate(input.from)) / DAY) + 1;
    const row = await tx.wfLeaveRequest.create({ data: { ...org(context), employeeId: employee.id, leaveType: input.type, fromDate: toDate(input.from), toDate: toDate(input.to), days, paid: input.paid ?? true, note: input.note ?? null, requestedByUserId: context.userId } });
    await audited(tx, context, 'leave.requested', 'employee', employee.id);
    return { id: row.id, days };
  });
}
export async function decideLeave(context, id, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    const row = await decide(tx, context, tx.wfLeaveRequest, id, expectedVersion, status);
    await audited(tx, context, `leave.${status.toLowerCase()}`, 'employee', row.employeeId);
    return { id, status };
  });
}
export async function requestHolidayWork(context, input) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const employee = await forEmployee(tx, context, who, input.employeeId);
    if (!await tx.wfHoliday.count({ where: { ...org(context), id: input.holidayId } })) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    const row = await tx.wfHolidayWorkRequest.create({ data: { ...org(context), employeeId: employee.id, holidayId: input.holidayId, reason: input.reason, hours: input.hours, requestedByUserId: context.userId } });
    await audited(tx, context, 'holiday_work.requested', 'employee', employee.id);
    return { id: row.id };
  });
}
export async function decideHolidayWork(context, id, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    const row = await decide(tx, context, tx.wfHolidayWorkRequest, id, expectedVersion, status);
    await audited(tx, context, `holiday_work.${status.toLowerCase()}`, 'employee', row.employeeId);
    return { id, status };
  });
}

// ---- timesheets -----------------------------------------------------------------------------------
async function loadSheet(tx, context, id) {
  const t = await tx.wfTimesheet.findFirst({ where: { ...org(context), id }, include: { lines: true } });
  if (!t) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
  const period = await tx.wfPeriod.findFirst({ where: { ...org(context), id: t.periodId } });
  return { t, period };
}
async function event(tx, context, t, status, submission, note) {
  await tx.wfTimesheetEvent.create({ data: { ...org(context), timesheetId: t.id, submission, status, byUserId: context.userId, note: note ?? null } });
}
export async function addManualLine(context, id, input) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const { t, period } = await loadSheet(tx, context, id);
    if (!who.sees(t.employeeId) || (t.employeeId !== who.self?.id && !who.all && !who.reports.includes(t.employeeId))) throw new EmrError('PERMISSION_DENIED');
    if (!['Open', 'Returned'].includes(t.status)) throw new EmrError('INVALID_STATE', { message: 'Only an open or returned timesheet can be edited.' });
    if (period.locked) throw new EmrError('PERIOD_LOCKED');
    if (input.date < isoDay(period.startDate) || input.date > isoDay(period.endDate)) throw new EmrError('VALIDATION_FAILED', { message: 'The line must fall inside the timesheet period.' });
    const line = await tx.wfTimesheetLine.create({ data: { ...org(context), timesheetId: t.id, workDate: toDate(input.date), source: 'Manual', expectedHours: input.expectedHours ?? 0, workedHours: input.workedHours, breakHours: input.breakHours ?? 0, overtimeHours: input.overtimeHours ?? 0, container: input.container ?? null, task: input.task ?? null, note: input.note ?? null } });
    await audited(tx, context, 'timesheet.line_added', 'timesheet', t.id);
    return { id: line.id };
  });
}
export async function submitTimesheet(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const { t, period } = await loadSheet(tx, context, id);
    if (t.employeeId !== who.self?.id && !who.all && !who.reports.includes(t.employeeId)) throw new EmrError('PERMISSION_DENIED');
    if (!['Open', 'Returned'].includes(t.status)) throw new EmrError('INVALID_STATE', { message: 'Only an open or returned timesheet can be submitted.' });
    if (period.locked) throw new EmrError('PERIOD_LOCKED');
    // Freeze the attendance-derived lines with this submission.
    if (t.captureMode !== 'Manual') {
      const own = { ...org(context), employeeId: t.employeeId };
      const [intervals, overtime, sc] = await Promise.all([
        tx.wfAttendance.findMany({ where: { ...own, clockInAt: { gte: new Date(period.startDate.getTime() - DAY), lte: new Date(period.endDate.getTime() + 2 * DAY) } } }),
        tx.wfOvertimeRequest.findMany({ where: { ...own, status: 'Approved' } }),
        scheduleContext(tx, context, t.employeeId),
      ]);
      const lines = attendanceLines(intervals, period, sc.assignments, sc.schedules, sc.blocks, overtime);
      await tx.wfTimesheetLine.deleteMany({ where: { ...org(context), timesheetId: t.id, source: 'Attendance' } });
      if (lines.length) await tx.wfTimesheetLine.createMany({ data: lines.map((l) => ({ ...org(context), timesheetId: t.id, workDate: toDate(l.date), source: 'Attendance', expectedHours: l.expectedHours, workedHours: l.workedHours, breakHours: l.breakHours, overtimeHours: l.overtimeHours })) });
    }
    const submission = t.submission + 1;
    await updateVersioned(tx.wfTimesheet, { organizationId: context.organizationId, id, expectedVersion, data: { status: 'Submitted', submission, submittedAt: new Date(), returnNote: null }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    await event(tx, context, t, 'Submitted', submission);
    await audited(tx, context, 'timesheet.submitted', 'timesheet', id);
    return { id, status: 'Submitted', submission };
  });
}
export async function recallTimesheet(context, id, expectedVersion) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const { t } = await loadSheet(tx, context, id);
    if (t.employeeId !== who.self?.id) throw new EmrError('PERMISSION_DENIED');
    if (t.status !== 'Submitted') throw new EmrError('INVALID_STATE', { message: 'Only a submitted timesheet can be recalled.' });
    await updateVersioned(tx.wfTimesheet, { organizationId: context.organizationId, id, expectedVersion, data: { status: 'Open' }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    await tx.wfTimesheetLine.deleteMany({ where: { ...org(context), timesheetId: t.id, source: 'Attendance' } });
    await event(tx, context, t, 'Open', t.submission, 'Recalled by employee');
    return { id, status: 'Open' };
  });
}
export async function decideTimesheet(context, id, expectedVersion, { status, note }) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const { t, period } = await loadSheet(tx, context, id);
    requireDecider(who, t.employeeId);
    if (t.status !== 'Submitted') throw new EmrError('INVALID_STATE', { message: 'Only a submitted timesheet can be decided.' });
    if (period.locked) throw new EmrError('PERIOD_LOCKED');
    const approved = status === 'Approved';
    await updateVersioned(tx.wfTimesheet, {
      organizationId: context.organizationId, id, expectedVersion, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND',
      data: { status, ...(approved ? { approvedAt: new Date(), approverUserId: context.userId } : {}), returnNote: status === 'Returned' ? note : null },
    });
    if (status === 'Returned') await tx.wfTimesheetLine.deleteMany({ where: { ...org(context), timesheetId: t.id, source: 'Attendance' } });
    await event(tx, context, t, status, t.submission, note);
    await audited(tx, context, `timesheet.${status.toLowerCase()}`, 'timesheet', id);
    return { id, status };
  });
}
export async function requestAmendment(context, input) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const { t } = await loadSheet(tx, context, input.timesheetId);
    if (!who.sees(t.employeeId)) throw new EmrError('PERMISSION_DENIED');
    if (t.status !== 'Locked') throw new EmrError('INVALID_STATE', { message: 'Amendments are for locked timesheets; edit an open one directly.' });
    const row = await tx.wfAmendment.create({ data: { ...org(context), timesheetId: t.id, reason: input.reason, change: input.change, requestedByUserId: context.userId } });
    await audited(tx, context, 'timesheet.amendment_requested', 'timesheet', t.id);
    return { id: row.id };
  });
}
export async function decideAmendment(context, id, expectedVersion, { status, note }) {
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const a = await tx.wfAmendment.findFirst({ where: { ...org(context), id } });
    if (!a) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    const { t } = await loadSheet(tx, context, a.timesheetId);
    requireDecider(who, t.employeeId);
    if (a.requestedByUserId === context.userId) throw new EmrError('OWN_REQUEST');
    if (a.status !== 'Pending') throw new EmrError('INVALID_STATE', { message: 'This amendment has already been decided.' });
    await updateVersioned(tx.wfAmendment, { organizationId: context.organizationId, id, expectedVersion, data: { status, decidedByUserId: context.userId, decidedAt: new Date(), decisionNote: note ?? null }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    // An approved amendment is an addendum on the locked sheet's history — the record itself is kept.
    if (status === 'Approved') await event(tx, context, t, t.status, t.submission, `Amendment approved: ${a.change}`);
    await audited(tx, context, `timesheet.amendment_${status.toLowerCase()}`, 'timesheet', t.id);
    return { id, status };
  });
}

// ---- work -----------------------------------------------------------------------------------------
export async function addContainer(context, input) {
  return withTenant(context, async (tx) => {
    try {
      const row = await tx.wfWorkContainer.create({ data: { ...org(context), ...input } });
      await audited(tx, context, 'work_container.created', 'work_container', row.id);
      return { id: row.id };
    } catch (error) { throw uniqueViolation(error, { code: 'HR_CODE_IN_USE' }) ?? error; }
  });
}
export async function addTask(context, input) {
  return withTenant(context, async (tx) => {
    const container = await tx.wfWorkContainer.findFirst({ where: { ...org(context), id: input.containerId } });
    if (!container) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    if (container.status !== 'Active') throw new EmrError('INVALID_STATE', { message: 'This work item is closed.' });
    if (input.parentId && !await tx.wfWorkTask.count({ where: { ...org(context), id: input.parentId, containerId: input.containerId } })) throw new EmrError('VALIDATION_FAILED', { message: 'The parent task must be in the same work item.' });
    const row = await tx.wfWorkTask.create({ data: { ...org(context), ...input } });
    await audited(tx, context, 'work_task.created', 'work_task', row.id);
    return { id: row.id };
  });
}
export async function setTaskStatus(context, id, expectedVersion, { status }) {
  return withTenant(context, async (tx) => {
    await updateVersioned(tx.wfWorkTask, { organizationId: context.organizationId, id, expectedVersion, data: { status }, notFoundCode: 'WORKFORCE_RECORD_NOT_FOUND' });
    await audited(tx, context, 'work_task.status_changed', 'work_task', id);
    return { id, status };
  });
}
export async function logActivity(context, input) {
  if (input.date > localParts(new Date()).day) throw new EmrError('VALIDATION_FAILED', { message: 'Log time for today or earlier.' });
  return withTenant(context, async (tx) => {
    const who = await actor(tx, context);
    const task = await tx.wfWorkTask.findFirst({ where: { ...org(context), id: input.taskId } });
    if (!task) throw new EmrError('WORKFORCE_RECORD_NOT_FOUND');
    const staff = input.staff ?? who.self?.name;
    if (!staff) throw new EmrError('NO_EMPLOYEE_RECORD');
    if (input.staff && input.staff !== who.self?.name && !who.all) throw new EmrError('PERMISSION_DENIED');
    const row = await tx.wfWorkActivity.create({ data: { ...org(context), taskId: task.id, staff, workDate: toDate(input.date), hours: input.hours, note: input.note ?? '', loggedByUserId: context.userId } });
    await audited(tx, context, 'work_activity.logged', 'work_task', task.id);
    return { id: row.id };
  });
}
