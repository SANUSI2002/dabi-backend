import prisma from '../../config/db.js';

// EMR_API_ENABLED is the switch; EMR_PATIENT_REGISTRY_ENABLED is the older name, still honoured.
export const emrPatientRegistryEnabled = () => process.env.EMR_API_ENABLED === 'true' || process.env.EMR_PATIENT_REGISTRY_ENABLED === 'true';

/** True when the organization's approved, set-up package (published) includes the product `key`. */
export async function approvedProductFor(context, key, db = prisma) {
  if (!context?.organization?.facilityId || context.organization.type === 'PHARMACY') return false;
  const application = await db.platformApplication.findUnique({
    where: { approvedOrganisationId: context.organization.facilityId },
    select: { status: true, setupCompletedAt: true, packageVersion: { select: { status: true, moduleKeys: true } } },
  });
  return application?.status === 'APPROVED' && !!application.setupCompletedAt
    && application.packageVersion?.status === 'PUBLISHED'
    && application.packageVersion.moduleKeys.includes(key);
}

/** The organization's approved, set-up, published package — its name, version and the products it includes — or null. */
export async function approvedPackageFor(context, db = prisma) {
  if (!context?.organization?.facilityId || context.organization.type === 'PHARMACY') return null;
  const application = await db.platformApplication.findUnique({
    where: { approvedOrganisationId: context.organization.facilityId },
    select: { status: true, setupCompletedAt: true, packageVersion: { select: { status: true, version: true, moduleKeys: true, package: { select: { name: true } } } } },
  });
  const version = application?.packageVersion;
  if (application?.status !== 'APPROVED' || !application.setupCompletedAt || version?.status !== 'PUBLISHED') return null;
  return { name: version.package.name, version: version.version, moduleKeys: version.moduleKeys };
}

export const approvedEmrFor = (context, db = prisma) => approvedProductFor(context, 'emr', db);

// The Workforce API (people, time & attendance, HR) follows the EMR switch unless switched on alone.
export const workforceApiEnabled = () => process.env.WORKFORCE_API_ENABLED === 'true' || emrPatientRegistryEnabled();
// Accounting likewise: its own switch, or the EMR's.
export const accountingApiEnabled = () => process.env.ACCOUNTING_API_ENABLED === 'true' || emrPatientRegistryEnabled();
