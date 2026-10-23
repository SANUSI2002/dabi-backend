// The HR audit slice: Workforce changes with who made them, no clinical events, and payroll entries
// only for payroll staff.
import request from 'supertest';
import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, newPatient } from './fixtures.js';

const at = (who, base = 'workforce') => (path) => `/api/v1/${base}/organizations/${who.organizationId}${path}`;
let A; let hr; let admin; let nurseEmp;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });

beforeAll(async () => {
  A = await createTenant('waA', { modules: ['emr', 'workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  const nurse = await member(A, ['NURSE']);
  await request(app).post(at(hr)('/people/employees/import-members')).set('Authorization', hr.auth).send({});
  nurseEmp = (await request(app).get(at(hr)('/people')).set('Authorization', hr.auth)).body.data.employees.find((e) => e.userId === nurse.userId);
  await request(app).patch(at(hr)(`/people/employees/${nurseEmp.id}`)).set('Authorization', hr.auth).set('If-Match', `W/"${nurseEmp.version}"`).send({ cadre: 'GL 08' });
  await request(app).put(at(hr)(`/payroll/structures/${nurseEmp.id}`)).set('Authorization', hr.auth).send({ basicSalary: 180000, allowances: [], deductions: [] });
  await request(app).post(at(admin, 'emr')('/patients')).set('Authorization', admin.auth).set('Idempotency-Key', crypto.randomUUID()).send(newPatient());
});

describe('HR audit trail', () => {
  it('lists Workforce changes with their actor, and nothing clinical', async () => {
    const res = await request(app).get(at(hr)('/people/audit-events')).set('Authorization', hr.auth);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.data.items;
    expect(items.find((e) => e.action === 'employee.updated' && e.resourceId === nurseEmp.id)).toMatchObject({ resourceType: 'employee', changedFields: ['cadre'], actorRoles: ['HR_OFFICER'], actorName: expect.any(String) });
    expect(items.some((e) => e.resourceType === 'patient')).toBe(false);
    expect(items.some((e) => e.action === 'payroll.structure_set')).toBe(true);
    const adminView = (await request(app).get(at(admin)('/people/audit-events')).set('Authorization', admin.auth)).body.data.items;
    expect(adminView.some((e) => e.action === 'payroll.structure_set')).toBe(false); // salary changes are payroll staff's
    expect(adminView.some((e) => e.action === 'employee.updated')).toBe(true);
  });
});
