import { activeMembershipFor, platformAccessFor } from '../modules/identity/identity.service.js';

const deny = (res, code = 'PERMISSION_DENIED', status = 403) => res.status(status).json({
  status: 'error',
  error: { code, message: status === 401 ? 'Authentication required.' : 'Access denied.' },
});

const load = (getContext) => async (req, res, next) => {
  if (!req.user?.id) return deny(res, 'AUTHENTICATION_REQUIRED', 401);
  try {
    req.accessContext = await getContext(req);
    return next();
  } catch (error) {
    if (error?.status === 401 || error?.status === 403) return deny(res, error.code, error.status);
    return next(error);
  }
};

// A tenant context must come from the verified JWT claim, never an untrusted
// organization header or a route parameter alone.
export const requireOrganization = load((req) => {
  if (!req.user.organizationId) {
    throw Object.assign(new Error('ORGANIZATION_REQUIRED'), { code: 'ORGANIZATION_REQUIRED', status: 403 });
  }
  return activeMembershipFor(req.user.id, req.user.organizationId);
});

export const requirePlatform = load(async (req) => {
  if (req.user.organizationId) {
    throw Object.assign(new Error('PLATFORM_CONTEXT_REQUIRED'), { code: 'PLATFORM_CONTEXT_REQUIRED', status: 403 });
  }
  const context = await platformAccessFor(req.user.id);
  if (!context.roles.length) {
    throw Object.assign(new Error('PLATFORM_ACCESS_DENIED'), { code: 'PLATFORM_ACCESS_DENIED', status: 403 });
  }
  return context;
});

export const requireRole = (roleCode) => (req, res, next) =>
  req.accessContext?.roles?.includes(roleCode) ? next() : deny(res);

export const requirePermission = (permissionCode) => (req, res, next) =>
  req.accessContext?.permissions?.includes(permissionCode) ? next() : deny(res);

export const requireAnyPermission = (...permissionCodes) => (req, res, next) =>
  permissionCodes.some((code) => req.accessContext?.permissions?.includes(code)) ? next() : deny(res);

export const requirePolicy = (policy) => async (req, res, next) => {
  if (!req.accessContext) return deny(res);
  try {
    return await policy(req, req.accessContext) ? next() : deny(res);
  } catch (error) {
    return next(error);
  }
};
