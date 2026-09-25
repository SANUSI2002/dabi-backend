import * as r from "./hospital-appointments.repository.js";
export const fail = (code) => Object.assign(new Error(code), { code });
export const create = (userId, data) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    if (data.dependentId && !(await r.dependent(tx, data.dependentId, userId)))
      throw fail("NOT_FOUND");
    const enrollment = await r.activeEnrollment(
      tx,
      userId,
      data.hospitalId,
      data.dependentId,
    );
    if (!enrollment) throw fail("NOT_FOUND");
    const item = await r.create(tx, {
      patientId: userId,
      hospitalId: data.hospitalId,
      dependentId: data.dependentId,
      enrollmentId: enrollment.id,
      status: "PENDING",
      requestedAt: new Date(data.requestedAt),
      appointmentType: data.appointmentType,
      reason: data.reason,
    });
    await r.audit(tx, userId, "HOSPITAL_APPOINTMENT_REQUESTED", item.id);
    return item;
  });
export const mine = (userId, query) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    return r.patientList(tx, userId, query);
  });
export const detail = (userId, id) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    const item = await r.patientDetail(tx, id, userId);
    if (!item) throw fail("NOT_FOUND");
    return item;
  });
export const hospital = (userId, query) =>
  r.transaction(async (tx) => {
    if (!(await r.owner(tx, userId))) throw fail("NOT_FOUND");
    return r.queue(tx, userId, query);
  });
const decide = (userId, id, status, reason) =>
  r.transaction(async (tx) => {
    if (!(await r.owner(tx, userId))) throw fail("NOT_FOUND");
    const changed = await r.transition(tx, id, userId, "PENDING", {
      status,
      decidedAt: new Date(),
      decidedByUserId: userId,
      ...(reason ? { decisionReason: reason } : {}),
    });
    if (changed.count !== 1) throw fail("NOT_FOUND");
    await r.audit(
      tx,
      userId,
      status === "SCHEDULED"
        ? "HOSPITAL_APPOINTMENT_CONFIRMED"
        : "HOSPITAL_APPOINTMENT_REJECTED",
      id,
    );
    return { id, status };
  });
export const confirm = (userId, id) => decide(userId, id, "SCHEDULED");
export const reject = (userId, id, reason) =>
  decide(userId, id, "REJECTED", reason);
export const checkIn = (userId, id) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    const changed = await r.checkIn(tx, id, userId);
    if (changed.count !== 1) throw fail("NOT_FOUND");
    await r.audit(tx, userId, "HOSPITAL_APPOINTMENT_CHECKED_IN", id);
    return { id, status: "CHECKED_IN" };
  });
