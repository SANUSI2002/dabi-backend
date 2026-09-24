import prisma from '../../config/db.js';

export const emrPatientRegistryEnabled = () => process.env.EMR_PATIENT_REGISTRY_ENABLED === 'true';

export async function approvedEmrFor(context, db = prisma) {
  if (!context?.organization?.facilityId || context.organization.type === 'PHARMACY') return false;
  const application = await db.platformApplication.findUnique({
    where: { approvedOrganisationId: context.organization.facilityId },
    select: { status: true, setupCompletedAt: true, packageVersion: { select: { status: true, moduleKeys: true } } },
  });
  return application?.status === 'APPROVED' && !!application.setupCompletedAt
    && application.packageVersion?.status === 'PUBLISHED'
    && application.packageVersion.moduleKeys.includes('emr');
}
