import prisma from "../../config/db.js";
export const tx = (f) =>
  prisma.$transaction(f, { isolationLevel: "Serializable" });
const published = {
  status: "PUBLISHED",
  provider: {
    OR: [
      { organisation: { status: "VERIFIED" } },
      { professional: { verificationStatus: "VERIFIED" } },
    ],
  },
};
const pub = {
  id: true,
  name: true,
  category: true,
  description: true,
  priceMinor: true,
  provider: {
    select: {
      id: true,
      organisation: {
        select: { id: true, name: true, address: true, city: true },
      },
      professional: {
        select: { id: true, practiceName: true, specialty: true },
      },
    },
  },
};
export const offerings = async (q) => {
  const where = {
    ...published,
    ...(q.category ? { category: q.category } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.wellnessOffering.findMany({
      where,
      select: pub,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: q.limit,
      skip: q.offset,
    }),
    prisma.wellnessOffering.count({ where }),
  ]);
  return { items, total, limit: q.limit, offset: q.offset };
};
export const offering = (id) =>
  prisma.wellnessOffering.findFirst({
    where: { id, ...published },
    select: pub,
  });
export const patient = (t, u) =>
  t.userRole.findFirst({
    where: { userId: u, role: "PATIENT" },
    select: { id: true },
  });
export const create = (t, d) =>
  t.wellnessBooking.create({
    data: d,
    select: {
      id: true,
      status: true,
      requestedAt: true,
      offering: { select: pub },
    },
  });
export const mine = async (t, u, q) => {
  const where = { patientId: u, ...(q.status ? { status: q.status } : {}) };
  const [items, total] = await Promise.all([
    t.wellnessBooking.findMany({
      where,
      select: {
        id: true,
        status: true,
        requestedAt: true,
        createdAt: true,
        offering: { select: pub },
      },
      orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
      take: q.limit,
      skip: q.offset,
    }),
    t.wellnessBooking.count({ where }),
  ]);
  return { items, total, limit: q.limit, offset: q.offset };
};
export const detailBooking = (t, id, u) =>
  t.wellnessBooking.findFirst({
    where: { id, patientId: u },
    select: {
      id: true,
      status: true,
      requestedAt: true,
      createdAt: true,
      offering: { select: pub },
    },
  });
export const provider = (t, u) =>
  t.wellnessProvider.findFirst({
    where: {
      OR: [
        { organisation: { ownerId: u, status: "VERIFIED" } },
        { professional: { userId: u, verificationStatus: "VERIFIED" } },
      ],
    },
    select: { id: true },
  });
export const queue = async (t, u, q) => {
  const p = await provider(t, u);
  if (!p) return null;
  const where = {
    offering: { providerId: p.id },
    ...(q.status ? { status: q.status } : {}),
  };
  const [items, total] = await Promise.all([
    t.wellnessBooking.findMany({
      where,
      select: {
        id: true,
        status: true,
        requestedAt: true,
        context: true,
        patient: { select: { id: true, full_name: true } },
        offering: { select: { id: true, name: true, category: true } },
      },
      take: q.limit,
      skip: q.offset,
      orderBy: [{ requestedAt: "asc" }, { id: "asc" }],
    }),
    t.wellnessBooking.count({ where }),
  ]);
  return { items, total, limit: q.limit, offset: q.offset };
};
export const change = async (t, u, id, status, reason) => {
  const p = await provider(t, u);
  if (!p) return { count: 0 };
  return t.wellnessBooking.updateMany({
    where: { id, status: "PENDING", offering: { providerId: p.id } },
    data: {
      status,
      decidedAt: new Date(),
      decisionReason: reason,
      decidedByUserId: u,
    },
  });
};
export const audit = (t, u, type, id) =>
  t.activityLog.create({
    data: {
      userId: u,
      type,
      description: "Wellness booking state changed",
      meta: { bookingId: id },
    },
  });
