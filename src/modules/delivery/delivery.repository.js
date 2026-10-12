import prisma from "../../config/db.js";
import { randomUUID } from "node:crypto";
import { codeFields, issueCodes } from "./delivery.codes.js";

// Serializable reads/writes protect assignment, activation and transition races.
export const transaction = (work) =>
  prisma.$transaction(work, { isolationLevel: "Serializable" });
export const role = (tx, userId, role) =>
  tx.userRole.findFirst({ where: { userId, role }, select: { id: true } });
export const activeUser = (tx, id) =>
  tx.user.findFirst({
    where: { id, accountStatus: "ACTIVE" },
    select: { id: true },
  });
const ownerWhere = (userId) => ({
  adminUserId: userId,
  identityOrganization: {
    memberships: {
      some: {
        userId,
        status: "ACTIVE",
        roles: { some: { roleCode: "PHARMACY_ADMIN" } },
      },
    },
  },
});
export const pharmacyOwner = (tx, userId) =>
  tx.pharmacy.findFirst({ where: ownerWhere(userId), select: { id: true } });
export const partnerSelect = {
  id: true,
  userId: true,
  displayName: true,
  isActive: true,
};
export const activePartner = (tx, where) =>
  tx.deliveryPartner.findFirst({
    where: {
      ...where,
      isActive: true,
      user: {
        accountStatus: "ACTIVE",
        roles: { some: { role: "DELIVERY_PARTNER" } },
        OR: [
          { riderApplication: { is: null } },
          {
            riderApplication: {
              is: {
                status: "APPROVED",
                licenceExpiresAt: {
                  gt: new Date(new Date().toISOString().slice(0, 10)),
                },
                insuranceExpiresAt: {
                  gt: new Date(new Date().toISOString().slice(0, 10)),
                },
              },
            },
          },
        ],
      },
    },
    select: partnerSelect,
  });
export const configure = async (tx, actorId, userId, data) => {
  if (
    !(await tx.user.findUnique({ where: { id: userId }, select: { id: true } }))
  )
    return null;
  await tx.userRole.upsert({
    where: { userId_role: { userId, role: "DELIVERY_PARTNER" } },
    create: { userId, role: "DELIVERY_PARTNER" },
    update: {},
  });
  return tx.deliveryPartner.upsert({
    where: { userId },
    create: { userId, ...data, configuredByUserId: actorId },
    update: { ...data, configuredByUserId: actorId },
    select: partnerSelect,
  });
};
export const partners = (tx, { limit, offset }) =>
  tx.deliveryPartner.findMany({
    where: {
      isActive: true,
      user: {
        accountStatus: "ACTIVE",
        roles: { some: { role: "DELIVERY_PARTNER" } },
        OR: [
          { riderApplication: { is: null } },
          {
            riderApplication: {
              is: {
                status: "APPROVED",
                licenceExpiresAt: {
                  gt: new Date(new Date().toISOString().slice(0, 10)),
                },
                insuranceExpiresAt: {
                  gt: new Date(new Date().toISOString().slice(0, 10)),
                },
              },
            },
          },
        ],
      },
    },
    select: { id: true, displayName: true },
    orderBy: { id: "asc" },
    take: limit,
    skip: offset,
  });
export const assignable = (tx, actorId, id) =>
  tx.orderFulfilment.findFirst({
    where: { id, pharmacy: ownerWhere(actorId) },
    select: {
      id: true,
      status: true,
      fulfilmentMethod: true,
      inventoryFinalizedAt: true,
      order: { select: { status: true, encryptedDeliveryDetails: true } },
      deliveryAssignments: {
        where: { status: { in: ["PENDING", "ACCEPTED", "COMPLETED"] } },
        select: { id: true },
      },
    },
  });
const assignmentSelect = {
  id: true,
  fulfilmentId: true,
  status: true,
  assignedAt: true,
  offerExpiresAt: true,
  respondedAt: true,
  pickedUpAt: true,
  outForDeliveryAt: true,
  deliveredAt: true,
};
const pickupSelect = {
  id: true,
  name: true,
  address: true,
  contactPhone: true,
};
export const createAssignment = async (tx, actorId, fulfilmentId, partnerId) => {
  await tx.$queryRaw`SELECT id FROM rider_pay_policies WHERE id = 'default' FOR SHARE`;
  const policy = await tx.riderPayPolicy.findUnique({ where: { id: 'default' } });
  let pay = {};
  if (policy?.published) {
    const f = await tx.orderFulfilment.findUnique({ where: { id: fulfilmentId }, select: { deliveryQuote: true } });
    const quote = f?.deliveryQuote;
    if (!Number.isFinite(quote?.distanceKm) || quote.distanceKm < 0 || !Number.isSafeInteger(quote?.ratePerKmMinor) || quote.ratePerKmMinor <= 0) throw Object.assign(new Error('This delivery needs a frozen kilometre quote before a rider earning can be offered.'), { code: 'RIDER_QUOTE_REQUIRED', status: 409 });
    const gross = Math.round(Math.round(quote.distanceKm * 1000) * quote.ratePerKmMinor / 1000);
    const offer = Math.floor((gross * policy.riderShareBps + 5000) / 10000);
    if (!Number.isSafeInteger(gross) || gross > 1000000000 || !Number.isSafeInteger(offer) || offer <= 0) throw Object.assign(new Error('The delivery price cannot produce a valid rider earning.'), { code: 'RIDER_QUOTE_REQUIRED', status: 409 });
    pay = { earningOfferMinor: offer, payGrossMinor: gross, payShareBps: policy.riderShareBps, payRetainedMinor: gross - offer, payPolicyVersion: policy.version };
  }
  await tx.$queryRaw`SELECT id FROM delivery_partners WHERE id = ${partnerId} FOR UPDATE`;
  if (policy?.published) {
    const open = await tx.deliveryAssignment.count({ where: { partnerId, status: { in: ['PENDING', 'ACCEPTED'] } } });
    if (open >= policy.maxOpenAssignments) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' });
  }
  const id = randomUUID();
  const assignment = await tx.deliveryAssignment.create({
    data: {
      id,
      fulfilmentId,
      partnerId,
      assignedByUserId: actorId,
      ...pay,
      ...(policy?.published ? { offerExpiresAt: new Date(Date.now() + policy.offerExpiryMinutes * 60000) } : {}),
      ...issueCodes(id),
    },
    select: { ...assignmentSelect, earningOfferMinor: true, payPolicyVersion: true },
  });
  const rider = await tx.deliveryPartner.findFirst({ where: { id: partnerId }, select: { userId: true } });
  await tx.notification.create({ data: { userId: rider.userId, title: 'New delivery offer', message: assignment.earningOfferMinor == null ? 'A new delivery is waiting. Open the offer to review, accept or reject it.' : `You can earn ${new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(assignment.earningOfferMinor / 100)} for this delivery. Open the offer to accept or reject it.`, category: 'DELIVERY', eventType: 'delivery.offer', eventKey: `delivery-offer:${id}`, link: `/rider/delivery/${id}` } });
  return assignment;
};
export const assignments = (tx, partnerId, { limit, offset }) =>
  tx.deliveryAssignment.findMany({
    where: { partnerId, status: { in: ["PENDING", "ACCEPTED"] } },
    select: {
      ...assignmentSelect,
      earningOfferMinor: true,
      fulfilment: {
        select: {
          status: true,
          deliveryQuote: true,
          pharmacy: { select: pickupSelect },
          order: { select: { reference: true } },
        },
      },
    },
    orderBy: [{ assignedAt: "asc" }, { id: "asc" }],
    take: limit,
    skip: offset,
  });
// Private, partner-scoped counts and history. No payment, medication or patient data.
export const partnerStats = async (tx, partnerId) => {
  const [pending, active, completed] = await Promise.all(
    ["PENDING", "ACCEPTED", "COMPLETED"].map((status) =>
      tx.deliveryAssignment.count({ where: { partnerId, status } }),
    ),
  );
  return { pending, active, completed };
};
export const history = (tx, partnerId, { limit, offset }) =>
  tx.deliveryAssignment.findMany({
    where: { partnerId, status: { in: ["COMPLETED", "REJECTED"] } },
    select: {
      ...assignmentSelect,
      earningOfferMinor: true,
      fulfilment: {
        select: {
          status: true,
          deliveryQuote: true,
          pharmacy: { select: pickupSelect },
          order: { select: { reference: true } },
        },
      },
    },
    orderBy: [{ respondedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    skip: offset,
  });
export const assigned = (tx, partnerId, id) =>
  tx.deliveryAssignment.findFirst({
    where: {
      id,
      partnerId,
      status: { in: ["PENDING", "ACCEPTED", "COMPLETED"] },
    },
    select: {
      ...assignmentSelect,
      partnerId: true,
      earningOfferMinor: true,
      payPolicyVersion: true,
      ...codeFields,
      fulfilment: {
        select: {
          id: true,
          status: true,
          deliveryQuote: true,
          pharmacy: { select: pickupSelect },
          order: {
            select: { reference: true, encryptedDeliveryDetails: true },
          },
        },
      },
    },
  });
// Never add codeFields to public tracking/queue projections.
export const holderFulfilment = (tx, userId, id, stage) =>
  tx.orderFulfilment.findFirst({
    where: {
      id,
      fulfilmentMethod: "DELIVERY",
      order: {
        status: "PAID",
        ...(stage === "delivery" ? { patientId: userId } : {}),
      },
      ...(stage === "pickup" ? { pharmacy: ownerWhere(userId) } : {}),
    },
    select: {
      id: true,
      status: true,
      pharmacy: { select: { name: true } },
      deliveryAssignments: {
        where: { status: { in: ["PENDING", "ACCEPTED", "COMPLETED"] } },
        orderBy: { assignedAt: "desc" },
        take: 1,
        select: {
          ...assignmentSelect,
          ...codeFields,
          partner: { select: { displayName: true } },
        },
      },
    },
  });
export const patientFulfilments = (tx, patientId, id) =>
  tx.order.findFirst({
    where: { id, patientId, status: "PAID" },
    select: {
      fulfilments: {
        where: { fulfilmentMethod: "DELIVERY" },
        select: { id: true },
      },
    },
  });
export const changeAssignment = (tx, id, status, data) =>
  tx.deliveryAssignment.updateMany({ where: { id, status }, data });
export const changeFulfilment = (tx, id, status, next) =>
  tx.orderFulfilment.updateMany({
    where: { id, status },
    data: { status: next },
  });
export const addLocation = (tx, assignmentId, data) =>
  tx.deliveryTrackingPoint.create({
    data: { assignmentId, ...data },
    select: { id: true, latitude: true, longitude: true, recordedAt: true },
  });
export const patientOrder = (tx, patientId, id) =>
  tx.order.findFirst({
    where: { id, patientId },
    select: {
      id: true,
      reference: true,
      status: true,
      fulfilments: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          status: true,
          fulfilmentMethod: true,
          pharmacy: { select: { id: true, name: true } },
          deliveryAssignments: {
            where: { status: { in: ["PENDING", "ACCEPTED", "COMPLETED"] } },
            select: {
              ...assignmentSelect,
              trackingPoints: {
                orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
                take: 100,
                select: { latitude: true, longitude: true, recordedAt: true },
              },
            },
          },
        },
      },
    },
  });
export const audit = (tx, userId, type, id) =>
  tx.activityLog.create({
    data: {
      userId,
      type,
      description: "Delivery operation",
      meta: { id },
    },
  });
