import prisma from '../../config/db.js';

export const list = async (userId, { page, limit, unreadOnly }) => {
  const where = { userId, ...(unreadOnly === 'true' ? { isRead: false } : {}) };
  const [items, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    prisma.notification.count({ where }), prisma.notification.count({ where: { userId, isRead: false } }),
  ]);
  return { items, page, limit, total, unreadCount };
};
export const markRead = (userId, id) => prisma.notification.updateMany({ where: { id, userId }, data: { isRead: true } });
export const markAllRead = (userId) => prisma.notification.updateMany({ where: { userId, isRead: false }, data: { isRead: true } });
