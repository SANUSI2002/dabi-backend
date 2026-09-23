import * as Care from './family-care.model.js';
const handle = (error, res, next) => error.code === 'FORBIDDEN' ? res.status(403).json({ status: 'error', message: 'Patient role required' }) : error.code === 'DUPLICATE' ? res.status(409).json({ status: 'error', message: 'Invitation already pending' }) : error.code === 'EXPIRED' ? res.status(410).json({ status: 'error', message: 'Invitation expired' }) : ['NOT_FOUND', 'INVALID_TRANSITION'].includes(error.code) ? res.status(404).json({ status: 'error', message: 'Relationship not found' }) : next(error);
export const list = async (req, res, next) => { try { res.json({ status: 'success', data: await Care.list(req.user.id, req.query) }); } catch (error) { next(error); } };
export const invite = async (req, res, next) => { try { res.status(201).json({ status: 'success', data: await Care.invite(req.user.id, req.body) }); } catch (error) { handle(error, res, next); } };
export const accept = async (req, res, next) => { try { res.json({ status: 'success', data: await Care.respond(req.user.id, req.body.token, true) }); } catch (error) { handle(error, res, next); } };
export const decline = async (req, res, next) => { try { res.json({ status: 'success', data: await Care.respond(req.user.id, req.body.token, false) }); } catch (error) { handle(error, res, next); } };
export const permissions = async (req, res, next) => { try { res.json({ status: 'success', data: await Care.updatePermissions(req.user.id, req.params.id, req.body.permissions) }); } catch (error) { handle(error, res, next); } };
export const revoke = async (req, res, next) => { try { await Care.revoke(req.user.id, req.params.id); res.json({ status: 'success' }); } catch (error) { handle(error, res, next); } };
export const access = async (req, res, next) => { try { res.json({ status: 'success', data: { permissions: await Care.access(req.user.id, req.params.patientId) } }); } catch (error) { next(error); } };


// Family-circle foundation uses the same CareRelationship records as legacy invitations.
import * as Foundation from './family-care.service.js';
const endpoint = (operation, created = false) => async (req, res, next) => {
  try { res.status(created ? 201 : 200).json({ status: 'success', data: await operation(req) }); }
  catch (error) {
    if (error.code === 'INVALID_INPUT') return res.status(400).json({ status: 'error', message: 'Invalid family-circle input' });
    if (['P2002', 'P2034'].includes(error.code)) return res.status(409).json({ status: 'error', message: 'Family circle changed; refresh and retry' });
    return handle(error, res, next);
  }
};
export const circle = endpoint((q) => Foundation.circle(q.user.id));
export const member = endpoint((q) => Foundation.memberDetail(q.user.id, q.params.id));
export const addMember = endpoint((q) => Foundation.addMember(q.user.id, q.body), true);
export const createLink = endpoint((q) => Foundation.createLink(q.user.id, q.body), true);
export const lookup = endpoint((q) => Foundation.lookup(q.user.id, q.body));
export const join = endpoint((q) => Foundation.join(q.user.id, q.body));
export const approve = endpoint((q) => Foundation.approve(q.user.id, q.params.id, q.body));
export const removeMember = endpoint((q) => Foundation.revokeMember(q.user.id, q.params.id));
export const createDependent = endpoint((q) => Foundation.createDependent(q.user.id, q.body), true);
export const dependent = endpoint((q) => Foundation.dependentDetail(q.user.id, q.params.id));
export const updateDependent = endpoint((q) => Foundation.updateDependent(q.user.id, q.params.id, q.body));
export const removeDependent = endpoint((q) => Foundation.removeDependent(q.user.id, q.params.id));
