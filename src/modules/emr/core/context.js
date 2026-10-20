// Resolves the EMR tenant for a request. Runs after `protect` + `requireOrganization`, so the
// tenant already comes from the verified JWT claim and an ACTIVE membership. Here we:
//   1. require the URL organization to equal the token's organization (the URL is never trusted),
//   2. require an active EMR entitlement (cached briefly — docs B7),
//   3. require the EMR API to be switched on,
// then expose req.emr = { organizationId, userId, requestId, roles, permissions }.
import { documented } from '../../../docs/routeMeta.js';
import { approvedProductFor, emrPatientRegistryEnabled, workforceApiEnabled } from '../emr.entitlement.js';
import { EmrError } from './errors.js';

export const emrApiEnabled = emrPatientRegistryEnabled;

const ENTITLEMENT_TTL_MS = 60_000;
const entitlementCache = new Map();
export const clearEntitlementCache = () => entitlementCache.clear();

async function entitled(accessContext, product = 'emr') {
  const key = `${accessContext.organization.id}:${product}`;
  const cached = entitlementCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.ok;
  const ok = await approvedProductFor(accessContext, product);
  entitlementCache.set(key, { ok, expiresAt: Date.now() + ENTITLEMENT_TTL_MS });
  if (entitlementCache.size > 20_000) entitlementCache.delete(entitlementCache.keys().next().value);
  return ok;
}

/** Tenant resolution for a product API: same tenancy (req.emr, RLS via withTenant), its own entitlement. */
const productTenant = (product, deniedCode, enabled, disabledCode) => async (req, res, next) => {
  try {
    const organization = req.accessContext?.organization;
    if (!organization || req.params.organizationId !== organization.id) throw new EmrError('ORGANIZATION_ACCESS_DENIED');
    if (!await entitled(req.accessContext, product)) throw new EmrError(deniedCode);
    if (!enabled()) throw new EmrError(disabledCode);
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

export const emrTenant = productTenant('emr', 'EMR_ACCESS_DENIED', emrApiEnabled, 'EMR_PATIENT_REGISTRY_DISABLED');
export const workforceTenant = productTenant('workforce', 'WORKFORCE_ACCESS_DENIED', workforceApiEnabled, 'WORKFORCE_API_DISABLED');

export const requireEmrPermission = (...codes) => documented((req, res, next) =>
  (codes.some((code) => req.emr?.permissions.includes(code)) ? next() : next(new EmrError('PERMISSION_DENIED'))), { permissions: codes, emr: true });

documented(emrTenant, { emrTenant: true });
documented(workforceTenant, { emrTenant: true });
