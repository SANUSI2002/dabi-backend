import prisma from '../../config/db.js';

const selectAppointment = { id: true, title: true, doctorName: true, time: true, type: true, status: true, cancelledAt: true, createdAt: true, updatedAt: true };
const notFound = () => Object.assign(new Error('Appointment not found'), { code: 'NOT_FOUND' });
const audit = (tx, userId, type, appointmentId, status) => tx.activityLog.create({ data: { userId, type, description: 'Appointment state changed', meta: { appointmentId, status } } });

export const list = async (userId, query) => {
  const { page, limit, status, type, from, to, sort } = query;
  const where = { userId, ...(status ? { status } : {}), ...(type ? { type } : {}), ...(from || to ? { time: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}) };
  const [items, total] = await Promise.all([prisma.appointment.findMany({ where, select: selectAppointment, orderBy: { time: sort }, skip: (page - 1) * limit, take: limit }), prisma.appointment.count({ where })]);
  return { items, page, limit, total };
};
export const getById = (userId, id) => prisma.appointment.findFirst({ where: { id, userId }, select: selectAppointment });
export const create = (userId, data) => prisma.$transaction(async (tx) => {
  const appointment = await tx.appointment.create({ data: { userId, ...data, time: new Date(data.time) }, select: selectAppointment });
  await audit(tx, userId, 'APPOINTMENT_CREATED', appointment.id, appointment.status);
  return appointment;
});
export const update = (userId, id, data) => prisma.$transaction(async (tx) => {
  const result = await tx.appointment.updateMany({ where: { id, userId, status: 'SCHEDULED' }, data: { ...data, ...(data.time ? { time: new Date(data.time) } : {}) } });
  if (!result.count) throw notFound();
  const appointment = await tx.appointment.findFirst({ where: { id, userId }, select: selectAppointment });
  await audit(tx, userId, 'APPOINTMENT_UPDATED', id, appointment.status);
  return appointment;
});
export const cancel = (userId, id) => prisma.$transaction(async (tx) => {
  const result = await tx.appointment.updateMany({ where: { id, userId, status: 'SCHEDULED' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
  if (!result.count) throw notFound();
  const appointment = await tx.appointment.findFirst({ where: { id, userId }, select: selectAppointment });
  await audit(tx, userId, 'APPOINTMENT_CANCELLED', id, 'CANCELLED');
  return appointment;
});
