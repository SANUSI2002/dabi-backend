// Resolves the EMR tenant for a request. Runs after `protect` + `requireOrganization`, so the
// tenant already comes from the verified JWT claim and an ACTIVE membership. Here we:
//   1. require the URL organization to equal the token's organization (the URL is never trusted),
//   2. require an active EMR entitlement (cached briefly — docs B7),
//   3. require the EMR API to be switched on,
// then expose req.emr = { organizationId, userId, requestId, roles, permissions }.
import { approvedEmrFor, emrPatientRegistryEnabled } from '../emr.entitlement.js';
import { EmrError } from './errors.js';

export const emrApiEnabled = emrPatientRegistryEnabled;

const ENTITLEMENT_TTL_MS = 60_000;
const entitlementCache = new Map();
export const clearEntitlementCache = () => entitlementCache.clear();

async function entitled(accessContext) {
  const key = accessContext.organization.id;
  const cached = entitlementCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  const ok = await approvedEmrFor(accessContext);
  entitlementCache.set(key, { ok, expiresAt: Date.now() + ENTITLEMENT_TTL_MS });
  if (entitlementCache.size > 20_000) entitlementCache.delete(entitlementCache.keys().next().value);
  return ok;
}

export const emrTenant = async (req, res, next) => {
  try {
    const organization = req.accessContext?.organization;
    if (!organization || req.params.organizationId !== organization.id) throw new EmrError('ORGANIZATION_ACCESS_DENIED');
    if (!await entitled(req.accessContext)) throw new EmrError('EMR_ACCESS_DENIED');
    if (!emrApiEnabled()) throw new EmrError('EMR_PATIENT_REGISTRY_DISABLED');
    req.emr = {
      organizationId: organization.id,
      facilityId: organization.facilityId ?? null,
      userId: req.user.id,
      requestId: req.requestId,
      roles: req.accessContext.roles ?? [],
      permissions: req.accessContext.permissions ?? [],
    };
    res.set('Cache-Control', 'no-store');
    return next();
  } catch (error) {
    return next(error);
  }
};

export const requireEmrPermission = (...codes) => (req, res, next) =>
  (codes.some((code) => req.emr?.permissions.includes(code)) ? next() : next(new EmrError('PERMISSION_DENIED')));
