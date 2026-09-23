import * as Notifications from './notifications.model.js';

export const listNotifications = async (req, res, next) => { try { return res.json({ status: 'success', data: await Notifications.list(req.user.id, req.query) }); } catch (error) { return next(error); } };
export const markNotificationRead = async (req, res, next) => { try { const result = await Notifications.markRead(req.user.id, req.params.id); if (!result.count) return res.status(404).json({ status: 'error', message: 'Notification not found' }); return res.json({ status: 'success' }); } catch (error) { return next(error); } };
export const markAllNotificationsRead = async (req, res, next) => { try { const result = await Notifications.markAllRead(req.user.id); return res.json({ status: 'success', data: { updated: result.count } }); } catch (error) { return next(error); } };
