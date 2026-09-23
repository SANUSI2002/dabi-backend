import * as repository from './hospital-plans.repository.js';
import { requireRole, fail } from '../organisations/organisations.policy.js';
export { fail };
export const requireHospital = async (tx, hospitalId, ownerId) => {
  if (ownerId) await requireRole(tx, ownerId, 'ORGANISATION_OWNER');
  if (!await repository.hospital(tx, hospitalId, ownerId)) throw fail('NOT_FOUND');
};
