import * as service from "./hospital-enrollments.service.js";
const handle =
  (work, code = 200) =>
  async (req, res, next) => {
    res.set("Cache-Control", "no-store");
    try {
      return res
        .status(code)
        .json({ status: "success", data: await work(req) });
    } catch (error) {
      if (error.code === "NOT_FOUND")
        return res
          .status(404)
          .json({ status: "error", message: "Hospital enrollment not found" });
      if (error.code === "DUPLICATE")
        return res
          .status(409)
          .json({
            status: "error",
            message: "An active or pending enrollment already exists",
          });
      if (error.code === "P2002" || error.code === "P2034")
        return res
          .status(409)
          .json({
            status: "error",
            message: "Enrollment changed. Reload and retry.",
          });
      return next(error);
    }
  };
export const create = handle(
  (req) => service.create(req.user.id, req.body),
  201,
);
export const mine = handle((req) => service.mine(req.user.id, req.query));
export const detail = handle((req) =>
  service.detail(req.user.id, req.params.id),
);
export const hospital = handle((req) =>
  service.hospital(req.user.id, req.query),
);
export const approve = handle((req) =>
  service.approve(req.user.id, req.params.id),
);
export const reject = handle((req) =>
  service.reject(req.user.id, req.params.id, req.body.reason),
);
export const errorHandler = (error, req, res, next) =>
  res
    .status(500)
    .json({
      status: "error",
      message: "Hospital enrollment service temporarily unavailable",
    });
