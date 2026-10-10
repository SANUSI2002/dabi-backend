import * as r from "./delivery.repository.js";
import { decryptDeliveryDetails } from "../orders/orders.delivery.js";
import {
  newCode,
  sealCode,
  openCode,
  equalCode,
  codeExpiry,
} from "./delivery.codes.js";

const fail = (code) => Object.assign(new Error(code), { code });
const requireRole = async (tx, userId, role) => {
  if (!(await r.activeUser(tx, userId)) || !(await r.role(tx, userId, role)))
    throw fail("FORBIDDEN");
};
const partner = async (tx, userId) => {
  const result = await r.activePartner(tx, { userId });
  if (!result) throw fail("FORBIDDEN");
  return result;
};
const owned = async (tx, userId, id) => {
  const profile = await partner(tx, userId);
  const assignment = await r.assigned(tx, profile.id, id);
  if (!assignment) throw fail("NOT_FOUND");
  return assignment;
};
const changed = (result) => {
  if (result.count !== 1) throw fail("CONFLICT");
};
export const configure = (actorId, userId, data, platformAuthorized = false) =>
  r.transaction(async (tx) => {
    if (platformAuthorized) {
      if (!(await r.activeUser(tx, actorId))) throw fail("FORBIDDEN");
    } else await requireRole(tx, actorId, "SUPER_ADMIN");
    if (!(await r.activeUser(tx, userId))) throw fail("NOT_FOUND");
    const result = await r.configure(tx, actorId, userId, data);
    if (!result) throw fail("NOT_FOUND");
    await r.audit(tx, actorId, "DELIVERY_PARTNER_CONFIGURED", result.id);
    return result;
  });
export const partners = (userId, page) =>
  r.transaction(async (tx) => {
    await requireRole(tx, userId, "PHARMACY_ADMIN");
    if (!(await r.pharmacyOwner(tx, userId))) throw fail("FORBIDDEN");
    return r.partners(tx, page);
  });
export const assign = (userId, id, { partnerId }) =>
  r.transaction(async (tx) => {
    await requireRole(tx, userId, "PHARMACY_ADMIN");
    const f = await r.assignable(tx, userId, id);
    if (!f) throw fail("NOT_FOUND");
    if (
      f.status !== "READY_FOR_PICKUP" ||
      f.fulfilmentMethod !== "DELIVERY" ||
      !f.inventoryFinalizedAt ||
      f.order.status !== "PAID" ||
      !f.order.encryptedDeliveryDetails ||
      f.deliveryAssignments.length
    )
      throw fail("CONFLICT");
    if (!(await r.activePartner(tx, { id: partnerId }))) throw fail("CONFLICT");
    const result = await r.createAssignment(tx, userId, id, partnerId);
    await r.audit(tx, userId, "DELIVERY_ASSIGNED", result.id);
    return result;
  });
const summary = (a) => ({
  id: a.id,
  fulfilmentId: a.fulfilmentId,
  assignmentStatus: a.status,
  fulfilmentStatus: a.fulfilment.status,
  reference: a.fulfilment.order.reference,
  pickup: a.fulfilment.pharmacy,
  assignedAt: a.assignedAt,
  respondedAt: a.respondedAt,
  pickedUpAt: a.pickedUpAt,
  outForDeliveryAt: a.outForDeliveryAt,
  deliveredAt: a.deliveredAt,
});
export const queue = (userId, page) =>
  r.transaction(async (tx) => {
    const profile = await partner(tx, userId);
    return (await r.assignments(tx, profile.id, page)).map(summary);
  });
export const detail = (userId, id) =>
  r.transaction(async (tx) => {
    const a = await owned(tx, userId, id);
    // Recipient details are disclosed only after this courier accepts the assignment.
    return {
      ...summary(a),
      ...(a.status !== "ACCEPTED"
        ? {}
        : {
            recipient: decryptDeliveryDetails(
              a.fulfilment.order.encryptedDeliveryDetails,
            ),
          }),
    };
  });
export const respond = (userId, id, reason) =>
  r.transaction(async (tx) => {
    const a = await owned(tx, userId, id);
    if (a.status !== "PENDING" || a.fulfilment.status !== "READY_FOR_PICKUP")
      throw fail("CONFLICT");
    const status = reason === undefined ? "ACCEPTED" : "REJECTED";
    changed(
      await r.changeAssignment(tx, id, "PENDING", {
        status,
        respondedAt: new Date(),
      ...(reason === undefined ? {} : { rejectionReason: reason }),
      ...(reason === undefined ? {} : { pickupCodeEncrypted: null, deliveryCodeEncrypted: null }),
      }),
    );
    // Rejection releases assignment only. Fulfilment remains ready; stock stays committed.
    await r.audit(tx, userId, `DELIVERY_ASSIGNMENT_${status}`, id);
    return {
      id,
      assignmentStatus: status,
      fulfilmentStatus: "READY_FOR_PICKUP",
    };
  });
const flow = {
  PICKED_UP: ["READY_FOR_PICKUP", "pickedUpAt"],
  OUT_FOR_DELIVERY: ["PICKED_UP", "outForDeliveryAt"],
  DELIVERED: ["OUT_FOR_DELIVERY", "deliveredAt"],
};
export const transition = async (userId, id, { status, code }) => {
  const result = await r.transaction(async (tx) => {
    const a = await owned(tx, userId, id);
    const [from, timestamp] = flow[status];
    if (a.status !== "ACCEPTED" || a.fulfilment.status !== from)
      throw fail("CONFLICT");
    const stage =
      status === "PICKED_UP"
        ? "pickup"
        : status === "DELIVERED"
          ? "delivery"
          : null;
    if (stage) {
      if (!code) throw fail("CODE_REQUIRED");
      const now = new Date(),
        prefix = `${stage}Code`;
      if (
        a[`${prefix}LockedUntil`] &&
        new Date(a[`${prefix}LockedUntil`]) > now
      )
        throw fail("CODE_LOCKED");
      if (
        !a[`${prefix}Encrypted`] ||
        !a[`${prefix}ExpiresAt`] ||
        new Date(a[`${prefix}ExpiresAt`]) <= now
      )
        throw fail("CODE_EXPIRED");
      if (!equalCode(code, openCode(id, stage, a[`${prefix}Encrypted`]))) {
        const attempts =
          (a[`${prefix}LockedUntil`] ? 0 : a[`${prefix}Attempts`] || 0) + 1;
        changed(
          await r.changeAssignment(tx, id, "ACCEPTED", {
            [`${prefix}Attempts`]: attempts,
            [`${prefix}LockedUntil`]:
              attempts >= 5 ? new Date(now.getTime() + 15 * 60000) : null,
          }),
        );
        await r.audit(
          tx,
          userId,
          `DELIVERY_${stage.toUpperCase()}_CODE_REJECTED`,
          id,
        );
        // Returning commits the durable attempt counter. Throw only AFTER transaction commits.
        return { error: attempts >= 5 ? "CODE_LOCKED" : "CODE_INVALID" };
      }
    }
    changed(await r.changeFulfilment(tx, a.fulfilmentId, from, status));
    changed(
      await r.changeAssignment(tx, id, "ACCEPTED", {
        [timestamp]: new Date(),
        ...(status === "DELIVERED" ? { status: "COMPLETED" } : {}),
        ...(stage ? { [`${stage}CodeEncrypted`]: null } : {}),
        ...(status === "PICKED_UP"
          ? { deliveryCodeExpiresAt: codeExpiry() }
          : {}),
      }),
    );
    await r.audit(tx, userId, `DELIVERY_${status}`, id);
    return {
      id,
      assignmentStatus: status === "DELIVERED" ? "COMPLETED" : "ACCEPTED",
      fulfilmentStatus: status,
    };
  });
  if (result.error) throw fail(result.error);
  return result;
};

const holder = async (tx, userId, id, stage, rotate = false) => {
  await requireRole(
    tx,
    userId,
    stage === "pickup" ? "PHARMACY_ADMIN" : "PATIENT",
  );
  const f = await r.holderFulfilment(tx, userId, id, stage);
  if (!f) throw fail("NOT_FOUND");
  const a = f.deliveryAssignments[0];
  const base = {
    fulfilmentId: id,
    pharmacyName: f.pharmacy.name,
    fulfilmentStatus: f.status,
    assignment: a
      ? {
          ...Object.fromEntries(
            ["id", "status", "pickedUpAt", "deliveredAt"].map((k) => [k, a[k]]),
          ),
          courierName: a.partner.displayName,
        }
      : null,
  };
  const eligible =
    a?.status === "ACCEPTED" &&
    (stage === "pickup"
      ? f.status === "READY_FOR_PICKUP"
      : ["PICKED_UP", "OUT_FOR_DELIVERY"].includes(f.status));
  if (!eligible) {
    if (rotate) throw fail("CONFLICT");
    return { ...base, code: null };
  }
  const now = new Date(),
    prefix = `${stage}Code`;
  if (rotate) {
    if (
      a[`${prefix}IssuedAt`] &&
      now - new Date(a[`${prefix}IssuedAt`]) < 60000
    )
      throw fail("CODE_ROTATION_LIMIT");
    const previous = a[`${prefix}Encrypted`]
      ? openCode(a.id, stage, a[`${prefix}Encrypted`])
      : null;
    let value;
    do {
      value = newCode();
    } while (value === previous);
    changed(
      await r.changeAssignment(tx, a.id, "ACCEPTED", {
        [`${prefix}Encrypted`]: sealCode(a.id, stage, value),
        [`${prefix}ExpiresAt`]: codeExpiry(now),
        [`${prefix}IssuedAt`]: now,
      }),
    );
    await r.audit(
      tx,
      userId,
      `DELIVERY_${stage.toUpperCase()}_CODE_REISSUED`,
      a.id,
    );
    return {
      ...base,
      code: value,
      expiresAt: codeExpiry(now),
      lockedUntil: a[`${prefix}LockedUntil`],
    };
  }
  const expiresAt = a[`${prefix}ExpiresAt`];
  const valid =
    a[`${prefix}Encrypted`] && expiresAt && new Date(expiresAt) > now;
  await r.audit(
    tx,
    userId,
    `DELIVERY_${stage.toUpperCase()}_CODE_VIEWED`,
    a.id,
  );
  return {
    ...base,
    code: valid ? openCode(a.id, stage, a[`${prefix}Encrypted`]) : null,
    expiresAt,
    lockedUntil: a[`${prefix}LockedUntil`],
    expired: !valid,
  };
};
export const pickupCode = (userId, id, rotate = false) =>
  r.transaction((tx) => holder(tx, userId, id, "pickup", rotate));
export const deliveryCodes = (userId, id) =>
  r.transaction(async (tx) => {
    await requireRole(tx, userId, "PATIENT");
    const order = await r.patientFulfilments(tx, userId, id);
    if (!order) throw fail("NOT_FOUND");
    return Promise.all(
      order.fulfilments.map((f) => holder(tx, userId, f.id, "delivery")),
    );
  });
export const rotateDeliveryCode = (userId, id) =>
  r.transaction((tx) => holder(tx, userId, id, "delivery", true));
export const location = (userId, id, data) =>
  r.transaction(async (tx) => {
    const a = await owned(tx, userId, id);
    if (
      a.status !== "ACCEPTED" ||
      !["PICKED_UP", "OUT_FOR_DELIVERY"].includes(a.fulfilment.status)
    )
      throw fail("CONFLICT");
    const result = await r.addLocation(tx, id, data);
    await r.audit(tx, userId, "DELIVERY_LOCATION_RECORDED", id);
    return result;
  });
// Keep the order's payment status intact and derive a separate aggregate tracking status.
export const trackingStatus = (fulfilments) => {
  const statuses = fulfilments.map((f) => f.status);
  if (statuses.length && statuses.every((s) => s === "DELIVERED"))
    return "DELIVERED";
  if (statuses.some((s) => s === "DELIVERED")) return "PARTIALLY_DELIVERED";
  if (statuses.some((s) => ["PICKED_UP", "OUT_FOR_DELIVERY"].includes(s)))
    return "IN_DELIVERY";
  if (statuses.length && statuses.every((s) => s === "READY_FOR_PICKUP"))
    return "READY_FOR_PICKUP";
  if (
    statuses.some((s) =>
      ["CLARIFICATION_REQUIRED", "REJECTED", "UNABLE_TO_FULFILL"].includes(s),
    )
  )
    return "ACTION_REQUIRED";
  if (statuses.length && statuses.every((s) => s === "CANCELLED"))
    return "CANCELLED";
  return "PROCESSING";
};
export const tracking = (userId, id) =>
  r.transaction(async (tx) => {
    await requireRole(tx, userId, "PATIENT");
    const order = await r.patientOrder(tx, userId, id);
    if (!order) throw fail("NOT_FOUND");
    return { ...order, trackingStatus: trackingStatus(order.fulfilments) };
  });
