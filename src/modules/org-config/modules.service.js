// Module switches (Platform & Modules). Rules enforced here:
//   - the approved package decides which products the organization holds; nothing here can add one;
//   - within a product it holds, platform.config (hospital admin, owner) switches modules and submodules
//     off and on; core modules can't be switched off, and a key the catalogue doesn't know is refused;
//   - a switched-off module's API paths are refused (MODULE_SWITCHED_OFF) for everyone, its records kept;
//   - every change is audited, with optimistic locking (no row yet = version 0).
import { withTenant } from '../emr/core/db.js';
import { recordAudit } from '../emr/core/audit.js';
import { EmrError } from '../emr/core/errors.js';
import { approvedPackageFor } from '../emr/emr.entitlement.js';
import { MODULES, PRODUCT_KEYS, keysForPath, switchable } from './modules.catalog.js';

const can = (context, ...permissions) => permissions.some((p) => context.permissions.includes(p));

// What each organization has switched off, cached briefly per process (like the entitlement cache);
// a change made through this process clears its organization at once.
const TTL_MS = 30_000;
const cache = new Map();
export const clearModuleCache = () => cache.clear();

async function disabledKeys(context) {
  const hit = cache.get(context.organizationId);
  if (hit && hit.expiresAt > Date.now()) return hit.keys;
  const row = await withTenant(context, (tx) => tx.platformModuleSettings.findUnique({ where: { organizationId: context.organizationId } }));
  const keys = new Set(row?.disabled ?? []);
  cache.set(context.organizationId, { keys, expiresAt: Date.now() + TTL_MS });
  if (cache.size > 20_000) cache.delete(cache.keys().next().value);
  return keys;
}

/** Middleware for a product's tenant router: refuses a request to a module the organization switched off. */
export const moduleGate = (product) => async (req, res, next) => {
  try {
    const keys = keysForPath(product, req.path);
    if (keys.length) {
      const off = await disabledKeys(req.emr);
      const hit = keys.find((k) => off.has(k));
      if (hit) throw new EmrError('MODULE_SWITCHED_OFF', { details: { module: hit } });
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

const licensedProducts = (pkg) => Object.fromEntries(PRODUCT_KEYS.map((p) => [p, !!pkg?.moduleKeys.includes(p)]));

export async function moduleOverview(context, accessContext) {
  const pkg = await approvedPackageFor(accessContext);
  const row = await withTenant(context, (tx) => tx.platformModuleSettings.findUnique({ where: { organizationId: context.organizationId } }));
  const off = new Set(row?.disabled ?? []);
  const products = licensedProducts(pkg);
  return {
    package: pkg ? { name: pkg.name, version: pkg.version } : null,
    products,
    modules: MODULES.map((m) => ({
      key: m.key, product: m.product, label: m.label, core: !!m.core, licensed: products[m.product],
      enabled: products[m.product] && (m.core || !off.has(m.key)),
      submodules: (m.submodules ?? []).map((s) => ({ key: s.key, label: s.label, enabled: products[m.product] && !off.has(m.key) && !off.has(s.key) })),
    })),
    disabled: [...off],
    version: row?.version ?? 0,
    editable: can(context, 'platform.config'),
  };
}

export async function saveModules(context, accessContext, expectedVersion, { disabled }) {
  if (!can(context, 'platform.config')) throw new EmrError('PERMISSION_DENIED');
  const products = licensedProducts(await approvedPackageFor(accessContext));
  const keys = [...new Set(disabled)];
  for (const key of keys) {
    const found = switchable(key);
    if (!found) throw new EmrError('VALIDATION_FAILED', { message: `${key} is not a module that can be switched off.` });
    if (!products[found.module.product]) throw new EmrError('VALIDATION_FAILED', { message: `${found.module.label} is not part of your package.` });
  }
  const result = await withTenant(context, async (tx) => {
    const row = await tx.platformModuleSettings.findUnique({ where: { organizationId: context.organizationId } });
    const before = new Set(row?.disabled ?? []);
    if (!row) {
      if (expectedVersion !== 0) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: 0 } });
      await tx.platformModuleSettings.create({ data: { organizationId: context.organizationId, disabled: keys, updatedByUserId: context.userId } });
    } else {
      const { count } = await tx.platformModuleSettings.updateMany({
        where: { organizationId: context.organizationId, version: expectedVersion },
        data: { disabled: keys, version: { increment: 1 }, updatedByUserId: context.userId, updatedAt: new Date() },
      });
      if (!count) throw new EmrError('VERSION_CONFLICT', { details: { currentVersion: row.version } });
    }
    const switchedOff = keys.filter((k) => !before.has(k));
    const switchedOn = [...before].filter((k) => !keys.includes(k));
    await recordAudit(tx, context, { action: 'modules.saved', resourceType: 'module_settings', resourceId: null, changedFields: [...switchedOff.map((k) => `off:${k}`), ...switchedOn.map((k) => `on:${k}`)] });
    return { saved: true, switchedOff, switchedOn };
  });
  cache.delete(context.organizationId);
  return result;
}
