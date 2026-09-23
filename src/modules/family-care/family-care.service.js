import crypto from 'node:crypto';
import * as r from './family-care.repository.js';

const fail = (code) => Object.assign(new Error(code), { code });
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const changed = (result) => { if (result.count !== 1) throw fail('NOT_FOUND'); };
const patient = async (tx, userId) => { if (!await r.isPatient(tx, userId)) throw fail('FORBIDDEN'); };
export const displayStatus = (member) => member.status === 'PENDING' && member.expiresAt && new Date(member.expiresAt) <= new Date() ? 'EXPIRED' : member.status;
const visible = (member) => ({ ...member, status: displayStatus(member) });
const pending = (member) => {
  if (!member) throw fail('NOT_FOUND');
  if (displayStatus(member) === 'EXPIRED') throw fail('EXPIRED');
  if (member.status !== 'PENDING' || member.revokedAt) throw fail('NOT_FOUND');
};
export const circle = (userId) => r.transaction(async (tx) => {
  const account = await r.user(tx, userId);
  if (!account) throw fail('NOT_FOUND');
  const owner = !!await r.isPatient(tx, userId);
  const owned = owner ? await r.members(tx, { patientId: userId }) : [];
  const invited = await r.members(tx, { OR: [{ caregiverId: userId }, ...(account.email ? [{ caregiverEmail: account.email.toLowerCase(), invitationKind: 'DIRECT' }] : [])] });
  // Never expand other circles or their dependents. Only this user's relationship is returned.
  const dependents = owner ? await r.dependents(tx, userId) : [];
  return { members: owned.map(visible), dependents,
    joinedCircles: invited.filter((m) => m.patientId !== userId).map(visible),
    empty: owned.length === 0 && invited.length === 0 && dependents.length === 0 };
});
export const memberDetail = (userId, id) => r.transaction(async (tx) => {
  await patient(tx, userId);
  const item = await r.member(tx, { id, patientId: userId });
  if (!item) throw fail('NOT_FOUND');
  // Acceptance allows a minimal member identity, never the invitee's medical profile.
  const account = item.caregiverId && item.status === 'ACTIVE' ? await r.user(tx, item.caregiverId) : null;
  return { ...visible(item), name: account?.full_name || item.caregiverEmail || 'Pending invitation' };
});
export const addMember = (userId, data) => r.transaction(async (tx) => {
  await patient(tx, userId);
  const owner = await r.user(tx, userId);
  const target = data.method === 'patientId' ? await r.byReference(tx, data.patientReference) : null;
  if (data.method === 'patientId' && !target?.email) throw fail('NOT_FOUND');
  const email = (target?.email ?? data.email).toLowerCase();
  if (target?.id === userId || email === owner?.email?.toLowerCase()) throw fail('INVALID_INPUT');
  if (await r.member(tx, { patientId: userId, caregiverEmail: email, status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ status: 'ACTIVE' }, { expiresAt: null }, { expiresAt: { gt: new Date() } }] })) throw fail('DUPLICATE');
  const token = crypto.randomBytes(32).toString('hex');
  const item = await r.createMember(tx, {
    patientId: userId, caregiverEmail: email, relationshipType: 'CAREGIVER', invitationKind: 'DIRECT',
    relationshipLabel: data.relationship ?? null, permissionLevel: data.permissionLevel,
    permissions: data.permissionLevel === 'emergency-only' ? [] : data.permissions,
    invitationTokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  await r.audit(tx, userId, 'CARE_INVITED', item.id);
  // Production email provider is not configured. Owner receives one-time secure handoff material.
  return { member: visible(item), token, delivery: 'MANUAL_SHARE_REQUIRED' };
});
export const createLink = (userId, { permissionLevel }) => r.transaction(async (tx) => {
  await patient(tx, userId);
  const token = crypto.randomBytes(32).toString('hex');
  const item = await r.createMember(tx, {
    patientId: userId, caregiverEmail: '', relationshipType: 'CAREGIVER', invitationKind: 'CIRCLE_LINK',
    permissionLevel, permissions: [], invitationTokenHash: hash(token), expiresAt: new Date(Date.now() + 7 * 86400000),
  });
  await r.audit(tx, userId, 'CARE_LINK_CREATED', item.id);
  return { id: item.id, token, expiresAt: item.expiresAt, qrPayload: token };
});
const invitation = async (tx, userId, token) => {
  const account = await r.user(tx, userId);
  if (!account?.email) throw fail('FORBIDDEN');
  const item = await r.byToken(tx, hash(token)); pending(item);
  if (item.patientId === userId || item.joinRequestedAt || (item.invitationKind !== 'CIRCLE_LINK' && item.caregiverEmail !== account.email.toLowerCase())) throw fail('NOT_FOUND');
  return { item, account };
};
export const lookup = (userId, { token }) => r.transaction(async (tx) => {
  const { item } = await invitation(tx, userId, token);
  const owner = await r.user(tx, item.patientId);
  // Token possession allows only the join confirmation, not membership or permission enumeration.
  return { name: 'Family Circle', ownerName: owner?.full_name ?? 'Patient', expiresAt: item.expiresAt };
});
export const join = (userId, { token, permissionLevel, requestedPermissions }) => r.transaction(async (tx) => {
  const { item, account } = await invitation(tx, userId, token);
  changed(await r.changeMember(tx, { id: item.id, status: 'PENDING', revokedAt: null, invitationTokenHash: hash(token), joinRequestedAt: null }, {
    caregiverId: userId, caregiverEmail: account.email.toLowerCase(), joinRequestedAt: new Date(),
    invitationTokenHash: null, permissionLevel, requestedPermissions, permissions: [],
  }));
  await r.audit(tx, userId, 'CARE_JOIN_REQUESTED', item.id);
  return { id: item.id, status: 'PENDING', permissions: [] };
});
export const approve = (userId, id, { permissions }) => r.transaction(async (tx) => {
  await patient(tx, userId);
  const item = await r.member(tx, { id, patientId: userId }); pending(item);
  if (!item.joinRequestedAt || !item.caregiverId) throw fail('NOT_FOUND');
  changed(await r.changeMember(tx, { id, patientId: userId, status: 'PENDING', revokedAt: null }, {
    status: 'ACTIVE', permissions, respondedAt: new Date(), invitationTokenHash: null,
  }));
  await r.audit(tx, userId, 'CARE_JOIN_APPROVED', id);
  return { id, status: 'ACTIVE', permissions };
});
export const revokeMember = (userId, id) => r.transaction(async (tx) => {
  await patient(tx, userId);
  changed(await r.changeMember(tx, { id, patientId: userId, status: { in: ['PENDING', 'ACTIVE', 'DECLINED', 'EXPIRED'] } }, {
    status: 'REVOKED', revokedAt: new Date(), invitationTokenHash: null, permissions: [], requestedPermissions: [],
  }));
  await r.audit(tx, userId, 'CARE_REVOKED', id);
  return { id, status: 'REVOKED' };
});
const coManagers = async (tx, userId, ids = []) => {
  if (!ids.length) return;
  const items = await r.members(tx, { id: { in: ids }, patientId: userId, status: 'ACTIVE', revokedAt: null, permissions: { has: 'PROFILE' } });
  if (items.length !== ids.length) throw fail('INVALID_INPUT');
};
const dependentData = (data) => ({ ...data, ...(data.dateOfBirth !== undefined ? { dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth) : null } : {}) });
export const createDependent = (userId, data) => r.transaction(async (tx) => {
  await patient(tx, userId); await coManagers(tx, userId, data.coManagerIds);
  const item = await r.createDependent(tx, { ...dependentData(data), patientId: userId });
  await r.audit(tx, userId, 'DEPENDENT_CREATED', item.id); return item;
});
export const updateDependent = (userId, id, data) => r.transaction(async (tx) => {
  await patient(tx, userId);
  if (!await r.dependent(tx, { id, patientId: userId })) throw fail('NOT_FOUND');
  await coManagers(tx, userId, data.coManagerIds);
  changed(await r.changeDependent(tx, { id, patientId: userId }, dependentData(data)));
  await r.audit(tx, userId, 'DEPENDENT_UPDATED', id);
  return r.dependent(tx, { id, patientId: userId });
});
export const removeDependent = (userId, id) => r.transaction(async (tx) => {
  await patient(tx, userId);
  changed(await r.removeDependent(tx, { id, patientId: userId }));
  await r.audit(tx, userId, 'DEPENDENT_REMOVED', id);
  return { id, removed: true };
});
export const dependentDetail = (userId, id) => r.transaction(async (tx) => {
  const owner = !!await r.isPatient(tx, userId);
  if (owner) { const item = await r.dependent(tx, { id, patientId: userId }); if (item) return item; }
  const links = await r.members(tx, { caregiverId: userId, status: 'ACTIVE', revokedAt: null, permissions: { has: 'PROFILE' } });
  if (!links.length) throw fail('NOT_FOUND');
  const item = await r.dependent(tx, { id, OR: links.map((link) => ({ patientId: link.patientId, coManagerIds: { has: link.id } })) });
  if (!item) throw fail('NOT_FOUND');
  const { fullName, nickname, dateOfBirth, gender, careType } = item;
  return { id, fullName, nickname, dateOfBirth, gender, careType };
});
