import express from "express";
import { protect } from "../../middleware/authMiddleware.js";
import { validate } from "../../middleware/validateMiddleware.js";
import * as v from "./wellness.validator.js";
import * as s from "./wellness.service.js";
const r = express.Router();
const h =
  (f, c = 200) =>
  async (q, res, next) => {
    try {
      res.status(c).json({ status: "success", data: await f(q) });
    } catch (e) {
      if (e.code === "NOT_FOUND")
        return res
          .status(404)
          .json({ status: "error", message: "Wellness resource not found" });
      next(e);
    }
  };
r.get(
  "/",
  validate(v.list),
  h((q) => s.list(q.query)),
);
r.get(
  "/bookings/mine",
  protect,
  validate(v.mine),
  h((q) => s.mine(q.user.id, q.query)),
);
r.get(
  "/bookings/provider",
  protect,
  validate(v.mine),
  h((q) => s.queue(q.user.id, q.query)),
);
r.post(
  "/bookings",
  protect,
  validate(v.book),
  h((q) => s.book(q.user.id, q.body), 201),
);
r.get(
  "/bookings/:id",
  protect,
  validate(v.detail),
  h((q) => s.booking(q.user.id, q.params.id)),
);
r.post(
  "/bookings/:id/confirm",
  protect,
  validate(v.decision),
  h((q) => s.confirm(q.user.id, q.params.id)),
);
r.post(
  "/bookings/:id/reject",
  protect,
  validate(v.decision),
  h((q) => s.reject(q.user.id, q.params.id, q.body.reason)),
);
r.get(
  "/:id",
  validate(v.detail),
  h((q) => s.detail(q.params.id)),
);
r.use((e, q, res, next) =>
  res
    .status(500)
    .json({
      status: "error",
      message: "Wellness module temporarily unavailable",
    }),
);
export default r;
