import * as HealthMetrics from './health-metrics.model.js';
export const listHealthMetrics = async (req, res, next) => { try { res.json({ status: 'success', data: await HealthMetrics.list(req.user.id, req.query) }); } catch (error) { next(error); } };
