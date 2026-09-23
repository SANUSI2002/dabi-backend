import { acceptInvitation, allowedPlatformInviteRoles, allowedTenantInviteRoles, issueInvitation, listInvitations, previewInvitation, revokeInvitation } from './identity.invitations.js';

const fail = (error, res, next) => error?.status && error?.code
  ? res.status(error.status).json({ status: 'error', error: { code: error.code, message: error.code === 'INVITATION_INVALID' ? 'This invitation is invalid, expired or no longer available.' : error.code.replaceAll('_', ' ').toLowerCase() } })
  : next(error);

const tenantScope = (req, res) => {
  if (req.params.organizationId === req.accessContext?.organization?.id) return true;
  res.status(403).json({ status: 'error', error: { code: 'ORGANIZATION_ACCESS_DENIED', message: 'Access denied.' } });
  return false;
};

export const invitationRoles = (req, res) => res.json({ status: 'success', data: { roles: req.params.organizationId ? allowedTenantInviteRoles(req.accessContext) : allowedPlatformInviteRoles(req.accessContext) } });

export const createPlatformInvitation = async (req, res, next) => {
  try { return res.status(201).json({ status: 'success', data: await issueInvitation(req.user.id, req.accessContext, 'PLATFORM', null, req.body) }); }
  catch (error) { return fail(error, res, next); }
};
export const createTenantInvitation = async (req, res, next) => {
  if (!tenantScope(req, res)) return;
  try { return res.status(201).json({ status: 'success', data: await issueInvitation(req.user.id, req.accessContext, 'ORGANIZATION', req.params.organizationId, req.body) }); }
  catch (error) { return fail(error, res, next); }
};
export const listPlatformInvitations = async (_req, res, next) => {
  try { return res.json({ status: 'success', data: { items: await listInvitations('PLATFORM', null) } }); }
  catch (error) { return next(error); }
};
export const listTenantInvitations = async (req, res, next) => {
  if (!tenantScope(req, res)) return;
  try { return res.json({ status: 'success', data: { items: await listInvitations('ORGANIZATION', req.params.organizationId) } }); }
  catch (error) { return next(error); }
};
export const revokePlatformInvitation = async (req, res, next) => {
  try { return res.json({ status: 'success', data: await revokeInvitation(req.user.id, req.params.id, 'PLATFORM', null) }); }
  catch (error) { return fail(error, res, next); }
};
export const revokeTenantInvitation = async (req, res, next) => {
  if (!tenantScope(req, res)) return;
  try { return res.json({ status: 'success', data: await revokeInvitation(req.user.id, req.params.id, 'ORGANIZATION', req.params.organizationId) }); }
  catch (error) { return fail(error, res, next); }
};
export const previewIdentityInvitation = async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); return res.json({ status: 'success', data: await previewInvitation(req.body.id, req.body.token) }); }
  catch (error) { return fail(error, res, next); }
};
export const acceptIdentityInvitation = async (req, res, next) => {
  try { res.set('Cache-Control', 'no-store'); return res.json({ status: 'success', data: await acceptInvitation(req.body) }); }
  catch (error) { return fail(error, res, next); }
};
