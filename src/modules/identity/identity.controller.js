import * as AuthModel from '../auth/auth.model.js';
import prisma from '../../config/db.js';
import { generateAccessToken } from '../auth/auth.token.js';
import { activeMembershipFor, acceptOwnMembership, inviteExistingIdentity, managedMemberships, membershipsFor, revokeManagedMembership } from './identity.service.js';

const fail = (error, res, next) => {
  if (error?.status && error?.code) return res.status(error.status).json({
    status: 'error',
    error: { code: error.code, message: error.status === 401 ? 'Authentication required.' : 'Access denied.' },
  });
  return next(error);
};

export const organizations = async (req, res, next) => {
  try {
    return res.json({ status: 'success', data: { items: await membershipsFor(req.user.id) } });
  } catch (error) { return fail(error, res, next); }
};

export const switchOrganization = async (req, res, next) => {
  try {
    const membership = await activeMembershipFor(req.user.id, req.body.organizationId);
    const user = await AuthModel.findUserById(req.user.id);
    if (!user || (user.accountStatus && user.accountStatus !== 'ACTIVE')) {
      return res.status(401).json({ status: 'error', error: { code: 'AUTHENTICATION_REQUIRED', message: 'Authentication required.' } });
    }
    return res.json({
      status: 'success',
      accessToken: generateAccessToken(user, { sessionId: req.user.sessionId, organizationId: membership.organization.id }),
      currentOrganization: membership,
    });
  } catch (error) { return fail(error, res, next); }
};

export const acceptMembership = async (req, res, next) => {
  try {
    const result = await acceptOwnMembership(req.user.id, req.params.id);
    return res.json({ status: 'success', data: result });
  } catch (error) { return fail(error, res, next); }
};

export const platformContext = (req, res) =>
  res.json({ status: 'success', data: req.accessContext });

// A signed-in platform staff member can discover that an assignment exists
// before setting up MFA. Roles and permissions remain behind /platform-context.
export const platformAssignment = (_req, res) =>
  res.json({ status: 'success', data: { assigned: true } });

const activePathOrganization = (req, res) => {
  if (req.params.organizationId === req.accessContext?.organization?.id) return true;
  res.status(403).json({ status: 'error', error: { code: 'ORGANIZATION_ACCESS_DENIED', message: 'Access denied.' } });
  return false;
};

export const emrAccess = async (req, res, next) => {
  if (!activePathOrganization(req, res)) return;
  try {
    const context = req.accessContext;
    if (context.organization.type === 'PHARMACY' || !context.organization.facilityId) {
      return res.status(403).json({ status: 'error', error: { code: 'EMR_ACCESS_DENIED', message: 'This organization has no EMR entitlement.' } });
    }
    const application = await prisma.platformApplication.findUnique({
      where: { approvedOrganisationId: context.organization.facilityId },
      select: { id: true, status: true, setupCompletedAt: true, packageVersion: { select: { status: true, moduleKeys: true } } },
    });
    if (application?.status !== 'APPROVED' || !application.setupCompletedAt
      || application.packageVersion.status !== 'PUBLISHED' || !application.packageVersion.moduleKeys.includes('emr')) {
      return res.status(403).json({ status: 'error', error: { code: 'EMR_ACCESS_DENIED', message: 'This organization has no active EMR entitlement.' } });
    }
    return res.set('Cache-Control', 'no-store').json({ status: 'success', data: {
      organizationId: context.organization.id, facilityId: context.organization.facilityId,
      organizationName: context.organization.name, roles: context.roles, permissions: context.permissions,
      clinicalApiConnected: false,
    } });
  } catch (error) { return next(error); }
};

export const listManagedMemberships = async (req, res, next) => {
  if (!activePathOrganization(req, res)) return;
  try { return res.json({ status: 'success', data: { items: await managedMemberships(req.params.organizationId) } }); }
  catch (error) { return fail(error, res, next); }
};

export const inviteMembership = async (req, res, next) => {
  if (!activePathOrganization(req, res)) return;
  try {
    const result = await inviteExistingIdentity(req.user.id, req.accessContext, req.body);
    return res.status(201).json({ status: 'success', data: result });
  } catch (error) { return fail(error, res, next); }
};

export const revokeMembership = async (req, res, next) => {
  if (!activePathOrganization(req, res)) return;
  try {
    return res.json({ status: 'success', data: await revokeManagedMembership(req.user.id, req.params.organizationId, req.params.id) });
  } catch (error) { return fail(error, res, next); }
};
