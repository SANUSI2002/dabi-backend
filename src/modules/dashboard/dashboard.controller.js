import * as DashboardModel from './dashboard.model.js';
import { recordsStatsResponseSchema } from './dashboard.validator.js';

// GET /api/v1/dashboard
export const getDashboard = async (req, res, next) => {
  try {
    const data = await DashboardModel.getDashboardOverview(req.user.id);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/dashboard/records-stats
export const getRecordsStats = async (req, res, next) => {
  try {
    const stats = await DashboardModel.getRecordsStats(req.user.id);
    // Enforce the response contract before it leaves the server.
    const data = recordsStatsResponseSchema.parse(stats);
    res.status(200).json({ status: 'success', data });
  } catch (error) {
    next(error);
  }
};
