import * as s from "./delivery.service.js";

const handle = (work) => async (req, res, next) => {
  try {
    res.json({ status: "success", data: await work(req) });
  } catch (error) {
    next(error);
  }
};
export const configure = handle((q) =>
  s.configure(q.user.id, q.params.id, q.body),
);
export const configurePlatform = handle((q) =>
  s.configure(q.user.id, q.params.id, q.body, true),
);
export const partners = handle((q) => s.partners(q.user.id, q.query));
export const assign = handle((q) => s.assign(q.user.id, q.params.id, q.body));
export const queue = handle((q) => s.queue(q.user.id, q.query));
export const detail = handle((q) => s.detail(q.user.id, q.params.id));
export const accept = handle((q) => s.respond(q.user.id, q.params.id));
export const reject = handle((q) =>
  s.respond(q.user.id, q.params.id, q.body.reason),
);
export const transition = handle((q) =>
  s.transition(q.user.id, q.params.id, q.body),
);
export const location = handle((q) =>
  s.location(q.user.id, q.params.id, q.body),
);
export const tracking = handle((q) => s.tracking(q.user.id, q.params.id));
export const pickupCode = handle((q) => s.pickupCode(q.user.id, q.params.id));
export const rotatePickupCode = handle((q) =>
  s.pickupCode(q.user.id, q.params.id, true),
);
export const deliveryCodes = handle((q) =>
  s.deliveryCodes(q.user.id, q.params.id),
);
export const rotateDeliveryCode = handle((q) =>
  s.rotateDeliveryCode(q.user.id, q.params.id),
);
export const errorHandler = (error, req, res, next) => {
  const codeMessages = {
    CODE_REQUIRED: "Enter the six-digit handover code.",
    CODE_INVALID: "Incorrect handover code. Ask the code holder to check it.",
    CODE_LOCKED:
      "Too many incorrect codes. Wait 15 minutes before trying again.",
    CODE_EXPIRED:
      "This code has expired. Ask the pharmacy or patient to generate a new code.",
    CODE_ROTATION_LIMIT: "Wait one minute before generating another code.",
  };
  const status =
    {
      CODE_REQUIRED: 400,
      CODE_INVALID: 400,
      CODE_LOCKED: 429,
      CODE_EXPIRED: 409,
      CODE_ROTATION_LIMIT: 429,
      FORBIDDEN: 403,
      NOT_FOUND: 404,
      CONFLICT: 409,
      P2002: 409,
      P2034: 409,
    }[error.code] ?? 500;
  const message = {
    403: "Access denied",
    404: "Delivery resource not found",
    409: "Delivery state changed or action unavailable",
    500: "Delivery temporarily unavailable",
  }[status];
  res
    .status(status)
    .json({
      status: "error",
      message: codeMessages[error.code] || message,
      ...(codeMessages[error.code] ? { code: error.code } : {}),
    });
};
