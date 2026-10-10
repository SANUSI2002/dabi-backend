// Documentation metadata carried by middleware (what a route validates, who may call it), read by
// scripts/build-openapi-routes.mjs to document every registered route. It never changes behaviour.
export const documented = (fn, meta) => Object.assign(fn, { openapi: { ...(fn.openapi ?? {}), ...meta } });
