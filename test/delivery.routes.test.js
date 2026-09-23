import express from 'express';
import jwt from 'jsonwebtoken';
import { Buffer } from 'node:buffer';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only Prisma is mocked: HTTP -> authentication -> Zod -> controller -> service -> repository.
const prisma = { $transaction: vi.fn() };
vi.mock('../src/config/db.js', () => ({ default: prisma }));
const { default: routes } = await import('../src/modules/delivery/delivery.routes.js');
const { default: authRoutes } = await import('../src/modules/auth/auth.routes.js');
const { encryptDeliveryDetails } = await import('../src/modules/orders/orders.delivery.js');
const { trackingStatus } = await import('../src/modules/delivery/delivery.service.js');
const uid = (n) => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const admin = uid(1), otherAdmin = uid(2), partner = uid(3), otherPartner = uid(4);
const patient = uid(5), otherPatient = uid(6), superAdmin = uid(7), fulfilmentId = uid(8), orderId = uid(9);
const partnerId = uid(10), otherPartnerId = uid(11), pharmacyId = uid(12);
const secret = 'delivery-http-test';
const recipient = { recipientName: 'Private Recipient', recipientPhone: '+2348012345678', address: '123 Private Street', coordinates: { latitude: 6, longitude: 3 } };
let state, tx, auditFailure, zeroUpdate, sequence;
const clone = (value) => JSON.parse(JSON.stringify(value));
const matches = (row, where = {}) => Object.entries(where).every(([key, expected]) => {
  const actual = row?.[key];
  if (expected && typeof expected === 'object') {
    if ('some' in expected) return actual?.some((item) => matches(item, expected.some));
    if ('in' in expected) return expected.in.includes(actual);
    return matches(actual, expected);
  }
  return actual === expected;
});
const project = (row, select) => {
  if (!row) return null;
  if (!select) return clone(row);
  return Object.fromEntries(Object.entries(select).map(([key, value]) => {
    let field = row[key];
    if (value === true) return [key, clone(field ?? null)];
    if (Array.isArray(field)) {
      field = field.filter((entry) => matches(entry, value.where));
      if (value.orderBy) field = sort(field, value.orderBy);
      return [key, field.slice(value.skip ?? 0, (value.skip ?? 0) + (value.take ?? field.length)).map((entry) => project(entry, value.select))];
    }
    return [key, project(field, value.select)];
  }));
};
const sort = (rows, order) => [...rows].sort((a, b) => {
  for (const clause of [order].flat()) for (const [key, direction] of Object.entries(clause)) {
    if (a[key] !== b[key]) return (a[key] < b[key] ? -1 : 1) * (direction === 'asc' ? 1 : -1);
  }
  return 0;
});
const hydrate = (model, row) => {
  if (model === 'deliveryPartner') return { ...row, user: { roles: state.userRole.filter((r) => r.userId === row.userId) } };
  if (model === 'orderFulfilment') return { ...row, order: state.order.find((o) => o.id === row.orderId), pharmacy: state.pharmacy.find((p) => p.id === row.pharmacyId), deliveryAssignments: state.deliveryAssignment.filter((a) => a.fulfilmentId === row.id) };
  if (model === 'deliveryAssignment') return { ...row, fulfilment: hydrate('orderFulfilment', state.orderFulfilment.find((f) => f.id === row.fulfilmentId)), trackingPoints: state.deliveryTrackingPoint.filter((p) => p.assignmentId === row.id) };
  if (model === 'order') return { ...row, fulfilments: state.orderFulfilment.filter((f) => f.orderId === row.id).map((f) => ({ ...f, pharmacy: state.pharmacy.find((p) => p.id === f.pharmacyId), deliveryAssignments: state.deliveryAssignment.filter((a) => a.fulfilmentId === f.id).map((a) => ({ ...a, trackingPoints: state.deliveryTrackingPoint.filter((p) => p.assignmentId === a.id) })) })) };
  return row;
};
const token = (userId, options) => `Bearer ${jwt.sign({ userId }, secret, options)}`;
const http = (method, path, userId = partner, body) => {
  const req = request(app)[method](`/delivery${path}`).set('Authorization', token(userId));
  return body === undefined ? req : req.send(body);
};
const app = express();
app.use(express.json());
app.use('/delivery', routes);
app.use('/auth', authRoutes);
const assign = async (target = partnerId) => http('post', `/fulfilments/${fulfilmentId}/assignment`, admin, { partnerId: target });
const post = (id, action, body = {}, userId = partner) => http('post', `/assignments/${id}/${action}`, userId, body);
const assigned = async () => { const response = await assign(); expect(response.status).toBe(200); return response.body.data.id; };
const accepted = async () => { const id = await assigned(); expect((await post(id, 'accept')).status).toBe(200); return id; };

beforeEach(() => {
  vi.clearAllMocks(); auditFailure = false; zeroUpdate = null; sequence = 20;
  process.env.JWT_SECRET = secret;
  process.env.ORDER_DELIVERY_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');
  state = {
    user: [admin, otherAdmin, partner, otherPartner, patient, otherPatient, superAdmin].map((id) => ({ id })),
    userRole: [[admin, 'PHARMACY_ADMIN'], [otherAdmin, 'PHARMACY_ADMIN'], [partner, 'DELIVERY_PARTNER'], [otherPartner, 'DELIVERY_PARTNER'], [patient, 'PATIENT'], [otherPatient, 'PATIENT'], [superAdmin, 'SUPER_ADMIN']].map(([userId, role]) => ({ id: uid(++sequence), userId, role })),
    deliveryPartner: [{ id: partnerId, userId: partner, displayName: 'Courier One', isActive: true }, { id: otherPartnerId, userId: otherPartner, displayName: 'Courier Two', isActive: true }],
    pharmacy: [{ id: pharmacyId, adminUserId: admin, name: 'Pickup Pharmacy', address: '456 Pickup Street', contactPhone: '+2348099999999', decisionNote: 'PRIVATE COMPLIANCE' }],
    order: [{ id: orderId, patientId: patient, reference: 'ORDER-REFERENCE', status: 'PAID', encryptedDeliveryDetails: encryptDeliveryDetails(recipient), totalPayableMinor: 999, paymentAttempts: ['PRIVATE PAYMENT'] }],
    orderFulfilment: [{ id: fulfilmentId, orderId, pharmacyId, status: 'READY_FOR_PICKUP', fulfilmentMethod: 'DELIVERY', inventoryFinalizedAt: new Date().toISOString(), decisionNote: 'PRIVATE CLINICAL', allocations: ['PRIVATE MEDICATION'], subtotalMinor: 500 }],
    deliveryAssignment: [], deliveryTrackingPoint: [], activityLog: [], inventory: [{ availableQuantity: 4 }],
  };
  tx = {};
  for (const model of ['user', 'userRole', 'deliveryPartner', 'order', 'orderFulfilment', 'deliveryAssignment', 'deliveryTrackingPoint', 'activityLog']) {
    tx[model] = {
      findFirst: vi.fn(async ({ where, select }) => project(state[model].map((row) => hydrate(model, row)).find((row) => matches(row, where)), select)),
      findMany: vi.fn(async ({ where, select, orderBy, take, skip = 0 }) => {
        let rows = state[model].map((row) => hydrate(model, row)).filter((row) => matches(row, where));
        if (orderBy) rows = sort(rows, orderBy);
        return rows.slice(skip, skip + (take ?? rows.length)).map((row) => project(row, select));
      }),
      create: vi.fn(async ({ data, select }) => {
        if (model === 'activityLog' && auditFailure) throw new Error('PRIVATE DATABASE ERROR');
        if (model === 'deliveryAssignment' && state.deliveryAssignment.some((a) => a.fulfilmentId === data.fulfilmentId && a.status !== 'REJECTED')) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
        const row = { id: uid(++sequence), ...(model === 'deliveryAssignment' ? { status: 'PENDING', assignedAt: new Date().toISOString() } : {}), ...(model === 'deliveryTrackingPoint' ? { recordedAt: new Date().toISOString() } : {}), ...data };
        state[model].push(row); return project(row, select);
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if (zeroUpdate === model) return { count: 0 };
        const rows = state[model].filter((row) => matches(row, where));
        rows.forEach((row) => Object.assign(row, data)); return { count: rows.length };
      }),
      upsert: vi.fn(async ({ where, create, update, select }) => {
        const row = state[model].find((row) => matches(row, where.userId_role ?? where));
        if (row) { Object.assign(row, update); return project(row, select); }
        return tx[model].create({ data: create, select });
      }),
    };
    tx[model].findUnique = tx[model].findFirst;
  }
  prisma.$transaction.mockImplementation(async (work) => {
    const snapshot = clone(state);
    try { return await work(tx); } catch (error) { state = snapshot; throw error; }
  });
});

describe('controlled provisioning and pharmacy assignment', () => {
  it('allows only Super Admin configuration of an existing account, with atomic role and audit', async () => {
    const path = `/operations/partners/${patient}`;
    const body = { displayName: 'Configured Courier', isActive: true };
    for (const actor of [patient, admin, partner]) expect((await http('put', path, actor, body)).status).toBe(403);
    expect((await http('put', path, superAdmin, body)).status).toBe(200);
    expect(state.userRole.some((r) => r.userId === patient && r.role === 'DELIVERY_PARTNER')).toBe(true);
    expect((await http('put', path, superAdmin, { ...body, isActive: false })).body.data.isActive).toBe(false);
    expect((await http('put', `/operations/partners/${uid(999)}`, superAdmin, body)).status).toBe(404);
  });
  it('does not allow role injection through public patient registration', async () => {
    const response = await request(app).post('/auth/register/patient').send({ email: 'courier@example.com', password: 'Password123!', firstName: 'Courier', lastName: 'One', consentGiven: true, role: 'DELIVERY_PARTNER' });
    expect(response.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('lists active configured partners with a minimal paginated projection', async () => {
    const response = await http('get', '/partners?limit=1&offset=0', admin);
    expect(response.body.data).toEqual([{ id: partnerId, displayName: 'Courier One' }]);
    expect((await http('get', '/partners', patient)).status).toBe(403);
    state.deliveryPartner[0].isActive = false;
    expect((await http('get', '/partners', admin)).body.data).toHaveLength(1);
  });
  it('assigns only own fulfilment, checks DB role, rejects duplicates, preserves committed inventory', async () => {
    expect((await http('post', `/fulfilments/${fulfilmentId}/assignment`, otherAdmin, { partnerId })).status).toBe(404);
    expect((await http('post', `/fulfilments/${fulfilmentId}/assignment`, patient, { partnerId })).status).toBe(403);
    const inventory = clone(state.inventory);
    await assigned(); expect((await assign()).status).toBe(409);
    expect(state.inventory).toEqual(inventory);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: 'Serializable' });
  });
  it.each(['AWAITING_PAYMENT', 'AWAITING_PHARMACIST_REVIEW', 'PREPARING', 'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED', 'REJECTED', 'CANCELLED'])('rejects assignment in %s', async (status) => {
    state.orderFulfilment[0].status = status;
    expect((await assign()).status).toBe(409); expect(state.deliveryAssignment).toEqual([]);
  });
  it('rejects pickup-only, uncommitted, unpaid, unconfigured and inactive assignments', async () => {
    state.orderFulfilment[0].fulfilmentMethod = 'PICKUP'; expect((await assign()).status).toBe(409);
    state.orderFulfilment[0].fulfilmentMethod = 'DELIVERY'; state.orderFulfilment[0].inventoryFinalizedAt = null; expect((await assign()).status).toBe(409);
    state.orderFulfilment[0].inventoryFinalizedAt = new Date(); state.order[0].status = 'PENDING_PAYMENT'; expect((await assign()).status).toBe(409);
    state.order[0].status = 'PAID'; expect((await assign(uid(999))).status).toBe(409);
    state.deliveryPartner[0].isActive = false; expect((await assign()).status).toBe(409);
    state.deliveryPartner[0].isActive = true; state.userRole = state.userRole.filter((r) => r.userId !== partner); expect((await assign()).status).toBe(409);
  });
});

describe('assignment isolation, delivery transitions and tracking privacy', () => {
  it('rejects and reassigns without restoring inventory or retaining old partner access', async () => {
    const id = await assigned(), snapshot = clone(state.inventory);
    expect((await post(id, 'reject', { reason: 'Vehicle unavailable' })).status).toBe(200);
    expect(state.deliveryAssignment[0].rejectionReason).toBe('Vehicle unavailable');
    expect(state.orderFulfilment[0].status).toBe('READY_FOR_PICKUP');
    const next = await assign(otherPartnerId); expect(next.status).toBe(200);
    expect((await http('get', `/assignments/${id}`, partner)).status).toBe(404);
    expect((await http('get', `/assignments/${next.body.data.id}`, partner)).status).toBe(404);
    expect((await post(id, 'accept')).status).toBe(404);
    expect((await http('get', '/assignments', partner)).body.data).toEqual([]);
    expect(state.inventory).toEqual(snapshot);
  });
  it('scopes queue/detail and every mutation to the active assigned partner', async () => {
    const id = await assigned();
    expect((await http('get', '/assignments', otherPartner)).body.data).toEqual([]);
    expect((await http('get', `/assignments/${id}`, otherPartner)).status).toBe(404);
    for (const [action, data] of [['accept', {}], ['reject', { reason: 'No' }], ['status', { status: 'PICKED_UP' }], ['locations', { latitude: 6, longitude: 3 }]]) {
      expect((await post(id, action, data, otherPartner)).status).toBe(404);
      expect((await post(id, action, data, patient)).status).toBe(403);
    }
    state.deliveryPartner[0].isActive = false;
    expect((await http('get', `/assignments/${id}`)).status).toBe(403);
    expect((await http('get', '/assignments')).status).toBe(403);
    expect((await post(id, 'accept')).status).toBe(403);
  });
  it('returns only pickup/status/reference in queue and minimal decrypted recipient in detail', async () => {
    const id = await assigned();
    const queue = await http('get', '/assignments');
    expect(queue.body.data[0].recipient).toBeUndefined();
    const response = await http('get', `/assignments/${id}`);
    expect(response.body.data.recipient).toEqual({ recipientName: recipient.recipientName, recipientPhone: recipient.recipientPhone, address: recipient.address });
    const json = JSON.stringify([queue.body, response.body]);
    for (const forbidden of ['encryptedDeliveryDetails', 'coordinates', 'patientId', 'paymentAttempts', 'totalPayableMinor', 'subtotalMinor', 'PRIVATE', 'allocations', 'decisionNote']) expect(json).not.toContain(forbidden);
    const select = tx.deliveryAssignment.findFirst.mock.calls[0][0].select;
    expect(select.fulfilment.select.order.select).toEqual({ reference: true, encryptedDeliveryDetails: true });
  });
  it('enforces accept then exact forward transitions and server timestamps; completion removes PII', async () => {
    const id = await assigned();
    expect((await post(id, 'status', { status: 'PICKED_UP' })).status).toBe(409);
    expect((await post(id, 'accept')).status).toBe(200);
    expect((await post(id, 'accept')).status).toBe(409);
    expect((await post(id, 'reject', { reason: 'Too late' })).status).toBe(409);
    expect((await post(id, 'status', { status: 'DELIVERED' })).status).toBe(409);
    expect((await post(id, 'locations', { latitude: 6, longitude: 3 })).status).toBe(409);
    for (const status of ['PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      expect((await post(id, 'status', { status })).body.data.fulfilmentStatus).toBe(status);
      expect((await post(id, 'status', { status })).status).toBe(409);
      if (status !== 'DELIVERED') {
        const point = await post(id, 'locations', { latitude: 6.5, longitude: 3.4 });
        expect(point.status).toBe(200); expect(Date.parse(point.body.data.recordedAt)).not.toBeNaN();
      }
    }
    expect(state.deliveryAssignment[0]).toMatchObject({ status: 'COMPLETED', pickedUpAt: expect.anything(), outForDeliveryAt: expect.anything(), deliveredAt: expect.anything() });
    expect((await post(id, 'locations', { latitude: 6, longitude: 3 })).status).toBe(409);
    expect((await http('get', `/assignments/${id}`)).body.data.recipient).toBeUndefined();
    expect(state.order[0].status).toBe('PAID'); expect(state.inventory).toEqual([{ availableQuantity: 4 }]);
  });
  it('rejects deactivated partners after acceptance and roles revoked after token issue', async () => {
    const id = await accepted(); state.deliveryPartner[0].isActive = false;
    expect((await post(id, 'status', { status: 'PICKED_UP' })).status).toBe(403);
    state.deliveryPartner[0].isActive = true; state.userRole = state.userRole.filter((r) => r.userId !== partner);
    expect((await post(id, 'status', { status: 'PICKED_UP' })).status).toBe(403);
  });
  it('patient sees only own relevant multi-pharmacy tracking, latest 100 locations, and parent aggregate', async () => {
    const id = await accepted(); await post(id, 'status', { status: 'PICKED_UP' });
    state.orderFulfilment.push({ ...state.orderFulfilment[0], id: uid(90), status: 'PREPARING', pharmacyId: uid(91) });
    state.pharmacy.push({ id: uid(91), name: 'Second Pharmacy' });
    for (let i = 0; i < 105; i++) state.deliveryTrackingPoint.push({ id: uid(100 + i), assignmentId: id, latitude: 6, longitude: 3, recordedAt: new Date(1000 * i).toISOString() });
    state.deliveryTrackingPoint.push({ id: uid(500), assignmentId: uid(999), latitude: 90, longitude: 180, recordedAt: new Date().toISOString() });
    const response = await http('get', `/orders/${orderId}/tracking`, patient);
    expect(response.status).toBe(200); expect(response.body.data).toMatchObject({ status: 'PAID', trackingStatus: 'IN_DELIVERY' });
    expect(response.body.data.fulfilments).toHaveLength(2);
    const points = response.body.data.fulfilments[0].deliveryAssignments[0].trackingPoints;
    expect(points).toHaveLength(100); expect(points[0].recordedAt).toBe(new Date(104000).toISOString());
    expect(JSON.stringify(response.body)).not.toMatch(/PRIVATE|encryptedDeliveryDetails|recipientPhone|totalPayableMinor|rejectionReason|partnerId|assignedByUserId/);
    expect((await http('get', `/orders/${orderId}/tracking`, otherPatient)).status).toBe(404);
    expect((await http('get', `/orders/${orderId}/tracking`, partner)).status).toBe(403);
  });
  it('derives parent delivery state without claiming mixed pickup orders delivered', () => {
    const aggregate = (...statuses) => trackingStatus(statuses.map((status) => ({ status })));
    expect(aggregate('DELIVERED', 'DELIVERED')).toBe('DELIVERED');
    expect(aggregate('DELIVERED', 'READY_FOR_PICKUP')).toBe('PARTIALLY_DELIVERED');
    expect(aggregate('READY_FOR_PICKUP')).toBe('READY_FOR_PICKUP');
    expect(aggregate('REJECTED')).toBe('ACTION_REQUIRED');
    expect(aggregate('CANCELLED')).toBe('CANCELLED');
    expect(aggregate('PREPARING')).toBe('PROCESSING');
  });
});

describe('strict validation, tokens and transactional failures', () => {
  it('rejects unknown fields, forbidden business mutations, invalid IDs, states and location ranges', async () => {
    const id = await assigned();
    for (const [action, data] of [['accept', { paymentStatus: 'PAID' }], ['reject', { reason: '' }], ['reject', { reason: 'x'.repeat(301) }], ['status', { status: 'READY_FOR_PICKUP' }], ['status', { status: 'PICKED_UP', price: 1 }], ['locations', { latitude: 91, longitude: 3 }], ['locations', { latitude: 6, longitude: -181 }], ['locations', { latitude: '6', longitude: 3 }], ['locations', { latitude: 6, longitude: 3, recordedAt: '2020-01-01' }]]) expect((await post(id, action, data)).status).toBe(400);
    expect((await http('get', '/assignments/not-uuid')).status).toBe(400);
    expect((await http('get', '/assignments?limit=101')).status).toBe(400);
    expect((await http('get', '/assignments?partnerId=other')).status).toBe(400);
    expect((await http('put', `/operations/partners/${partner}`, superAdmin, { displayName: 'Courier', isActive: 'true' })).status).toBe(400);
  });
  it.each([undefined, 'Basic abc', 'Bearer invalid', token(partner, { expiresIn: -1 }), `Bearer ${jwt.sign({ userId: partner }, 'wrong-secret')}`, `Bearer ${jwt.sign({}, secret)}`])('rejects token failure %s before database access', async (authorization) => {
    let req = request(app).get('/delivery/assignments'); if (authorization) req = req.set('Authorization', authorization);
    expect((await req).status).toBe(401); expect(prisma.$transaction).not.toHaveBeenCalled();
  });
  it('rolls back provisioning role/profile and assignment when audit fails', async () => {
    const snapshot = clone(state); auditFailure = true;
    expect((await http('put', `/operations/partners/${patient}`, superAdmin, { displayName: 'Courier', isActive: true })).status).toBe(500);
    expect(state).toEqual(snapshot);
    const response = await assign(); expect(response.status).toBe(500); expect(JSON.stringify(response.body)).not.toContain('PRIVATE');
    expect(state).toEqual(snapshot);
  });
  it('rolls back accept, reject, transitions and locations on audit failure', async () => {
    const id = await assigned(); let snapshot = clone(state); auditFailure = true;
    expect((await post(id, 'accept')).status).toBe(500); expect(state).toEqual(snapshot);
    expect((await post(id, 'reject', { reason: 'Unavailable' })).status).toBe(500); expect(state).toEqual(snapshot);
    auditFailure = false; await post(id, 'accept'); snapshot = clone(state); auditFailure = true;
    expect((await post(id, 'status', { status: 'PICKED_UP' })).status).toBe(500); expect(state).toEqual(snapshot);
    auditFailure = false; await post(id, 'status', { status: 'PICKED_UP' }); snapshot = clone(state); auditFailure = true;
    expect((await post(id, 'locations', { latitude: 6, longitude: 3 })).status).toBe(500); expect(state).toEqual(snapshot);
  });
  it('rolls back a fulfilment update if assignment compare-and-set loses a race', async () => {
    const id = await accepted(), snapshot = clone(state); zeroUpdate = 'deliveryAssignment';
    expect((await post(id, 'status', { status: 'PICKED_UP' })).status).toBe(409); expect(state).toEqual(snapshot);
  });
  it('maps serialization conflicts to retryable 409 and safely handles ciphertext/key failures', async () => {
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('DB detail'), { code: 'P2034' }));
    expect((await assign()).status).toBe(409);
    const id = await assigned(); state.order[0].encryptedDeliveryDetails = 'v1.bad.bad.bad';
    expect((await http('get', `/assignments/${id}`)).status).toBe(500);
    delete process.env.ORDER_DELIVERY_ENCRYPTION_KEY;
    expect((await http('get', `/assignments/${id}`)).status).toBe(500);
    expect((await http('get', `/assignments/${id}`, otherPartner)).status).toBe(404);
  });
});
