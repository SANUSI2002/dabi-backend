// Workforce lists the hospital configures, against real Postgres with RLS on: a policy category the
// hospital adds is accepted, one it never added is refused, and one it switches off is refused again.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant } from './fixtures.js';

const ifMatch = (version) => ({ 'If-Match': `W/"${version}"` });
const api = (base) => (who) => {
  const url = (path) => `/api/v1/${base}/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    patch: (path, body = {}, headers = {}) => request(app).patch(url(path)).set('Authorization', who.auth).set(headers).send(body),
  };
};
const workforce = api('workforce'); const config = api('org-config');
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let hr;
beforeAll(async () => {
  A = await createTenant('wlA', { modules: ['emr', 'workforce'] });
  hr = { ...(await addMember(A, ['HR_OFFICER'])), organizationId: A.organizationId };
});

describe("the hospital's own workforce lists", () => {
  it('publishes policies under the categories the hospital keeps', async () => {
    const publish = (category) => workforce(hr).post('/people/policies', { category, title: `Policy ${category}`, purpose: 'Sets expectations', body: 'The text of the policy.' });
    const refused = await publish('Infection Prevention');
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/Policy Categories/);
    ok(await config(hr).post('/master-data/policy-categories', { label: 'Infection Prevention' }), 201);
    ok(await publish('Infection Prevention'), 201);
    const conduct = ok(await config(hr).get('')).data['policy-categories'].find((i) => i.label === 'Conduct');
    ok(await config(hr).patch(`/master-data/policy-categories/${conduct.id}`, { active: false }, ifMatch(conduct.version)));
    expect((await publish('Conduct')).status).toBe(400);
  });

  it('files letter templates under the Letter Categories list', async () => {
    const add = (category) => config(hr).post('/letter-templates', { key: `memo-${category.length}`, name: 'Memo', category, body: 'Dear {{employee_name}},', signatories: ['HR'] });
    expect((await add('Welfare')).status).toBe(400);
    ok(await config(hr).post('/master-data/letter-categories', { label: 'Welfare' }), 201);
    ok(await add('Welfare'), 201);
  });
});
