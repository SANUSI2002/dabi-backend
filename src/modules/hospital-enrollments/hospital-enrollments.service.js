import * as r from "./hospital-enrollments.repository.js";
export const fail = (code) => Object.assign(new Error(code), { code });
const presentPatient = (x) => ({ ...x, currency: "NGN" });
export const create = (userId, data) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    if (!(await r.hospital(tx, data.hospitalId))) throw fail("NOT_FOUND");
    if (!(await r.plan(tx, data.hospitalId, data.planId)))
      throw fail("NOT_FOUND");
    if (data.dependentId && !(await r.dependent(tx, data.dependentId, userId)))
      throw fail("NOT_FOUND");
    if (await r.open(tx, userId, data.hospitalId, data.dependentId))
      throw fail("DUPLICATE");
    const item = await r.create(tx, {
      patientId: userId,
      hospitalId: data.hospitalId,
      planId: data.planId,
      dependentId: data.dependentId,
      patientNote: data.patientNote,
    });
    await r.audit(tx, userId, "HOSPITAL_ENROLLMENT_REQUESTED", item.id);
    return presentPatient(item);
  });
export const mine = (userId, query) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    const result = await r.mine(tx, userId, query);
    return { ...result, items: result.items.map(presentPatient) };
  });
export const detail = (userId, id) =>
  r.transaction(async (tx) => {
    if (!(await r.patient(tx, userId))) throw fail("NOT_FOUND");
    const item = await r.patientDetail(tx, id, userId);
    if (!item) throw fail("NOT_FOUND");
    return presentPatient(item);
  });
export const hospital = (userId, query) =>
  r.transaction(async (tx) => {
    if (!(await r.owner(tx, userId)) || !(await r.ownedHospital(tx, userId)))
      throw fail("NOT_FOUND");
    return r.ownerList(tx, userId, query);
  });
const decide = (userId, id, status, reason) =>
  r.transaction(async (tx) => {
    if (!(await r.owner(tx, userId))) throw fail("NOT_FOUND");
    const result = await r.change(tx, id, userId, status, {
      decidedAt: new Date(),
      decidedByUserId: userId,
      ...(reason ? { decisionReason: reason } : {}),
    });
    if (result.count !== 1) throw fail("NOT_FOUND");
    await r.audit(
      tx,
      userId,
      status === "ACTIVE"
        ? "HOSPITAL_ENROLLMENT_APPROVED"
        : "HOSPITAL_ENROLLMENT_REJECTED",
      id,
    );
    return { id, status };
  });
export const approve = (userId, id) => decide(userId, id, "ACTIVE");
export const reject = (userId, id, reason) =>
  decide(userId, id, "REJECTED", reason);
