import * as repository from './hospital-plans.repository.js';
import { fail, requireHospital } from './hospital-plans.policy.js';
import * as audit from './hospital-plans.audit.js';
const present = (plan) => ({ ...plan, currency: 'NGN' });
export const create = (actor, hospitalId, data) => repository.transaction(async (tx) => {
  await requireHospital(tx, hospitalId, actor);
  const plan = await repository.create(tx, hospitalId, data);
  await audit.record(tx, actor, 'HOSPITAL_PLAN_CREATED', hospitalId, plan.id);
  return present(plan);
});
export const list = (hospitalId, query, actor) => repository.transaction(async (tx) => {
  await requireHospital(tx, hospitalId, actor);
  const result = await repository.list(tx, hospitalId, query, actor);
  return { ...result, items: result.items.map(present) };
});
export const detail = (hospitalId, planId) => repository.transaction(async (tx) => {
  const plan = await repository.detail(tx, hospitalId, planId);
  if (!plan) throw fail('NOT_FOUND');
  return present(plan);
});
export const update = (actor, hospitalId, planId, data) => repository.transaction(async (tx) => {
  await requireHospital(tx, hospitalId, actor);
  if ((await repository.change(tx, hospitalId, planId, actor, data)).count !== 1) throw fail('NOT_FOUND');
  await audit.record(tx, actor, 'HOSPITAL_PLAN_UPDATED', hospitalId, planId);
  return present(await repository.detail(tx, hospitalId, planId, actor));
});
export const archive = (actor, hospitalId, planId) => repository.transaction(async (tx) => {
  await requireHospital(tx, hospitalId, actor);
  const plan = await repository.detail(tx, hospitalId, planId, actor);
  if (!plan) throw fail('NOT_FOUND');
  if (plan.status === 'ARCHIVED') return present(plan);
  if ((await repository.change(tx, hospitalId, planId, actor, { status: 'ARCHIVED', archivedAt: new Date() })).count !== 1) throw fail('NOT_FOUND');
  await audit.record(tx, actor, 'HOSPITAL_PLAN_ARCHIVED', hospitalId, planId);
  return present(await repository.detail(tx, hospitalId, planId, actor));
});
