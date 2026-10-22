// Equipment intelligence (SCADA).
//   /api/v1/emr/organizations/:organizationId/scada/...   register, device keys, detail, alarms (signed-in staff)
//   /api/v1/emr/scada/ingest                              devices push heartbeats, readings and events
//                                                         (Authorization: Device sdk.<org>.<keyId>.<secret>)
//
// Who can do what (the equipment register's permissions, migration 20261108090000_emr_assets):
//   equipment.read    the command centre, equipment detail, telemetry and timeline
//   equipment.report  raise, acknowledge and investigate alarms
//   equipment.manage  register, edit, move and decommission equipment; issue and revoke device keys;
//                     escalate, resolve, close and suppress alarms
import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../core/context.js';
import { handle, validateEmr as check } from '../core/validate.js';
import { requireVersion } from '../core/concurrency.js';
import { send } from '../core/http.js';
import { EmrError } from '../core/errors.js';
import { CATEGORIES } from './scada.params.js';
import * as scada from './scada.service.js';
import * as care from './scada.care.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const free = (max) => z.string().trim().max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])*$/u, 'Contains control characters');
const date = z.iso.datetime({ offset: true }).or(z.iso.date());
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const MACHINE = ['Unknown', 'Offline', 'Powered Off', 'Starting', 'Ready', 'Idle', 'Running', 'Warning', 'Error', 'Critical', 'Maintenance', 'Calibration'];
const EVENT_TYPES = ['POWER_ON', 'POWER_OFF', 'STARTING', 'READY', 'IDLE', 'TEST_STARTED', 'TEST_COMPLETED', 'RESULT_GENERATED', 'WARNING', 'ERROR', 'MAINTENANCE_STARTED', 'MAINTENANCE_COMPLETED',
  'CALIBRATION_STARTED', 'CALIBRATION_COMPLETED', 'OFFLINE', 'CONNECTION_LOST', 'CONNECTION_RESTORED'];
const SEVERITIES = ['Informational', 'Low', 'Medium', 'High', 'Critical', 'Emergency'];
const ALARM_CATEGORIES = ['Threshold Breach', 'Connectivity', 'Calibration', 'Maintenance', 'Safety', 'Unauthorized Activity', 'Consumable', 'Warranty', 'Power', 'Other'];

const location = z.object({ building: text(80), floor: free(40).optional(), department: text(80), ward: free(80).optional(), room: free(80).optional(), exact: free(120).optional() }).strict();
const procurement = z.object({
  supplier: free(120).optional(), purchaseDate: date.optional(), purchaseOrderNo: free(60).optional(), invoiceNo: free(60).optional(), purchasePrice: z.number().min(0).max(1e13).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(), installationCost: z.number().min(0).max(1e13).optional(),
}).strict();
const lifecycle = z.object({
  installationDate: date.optional(), commissioningDate: date.optional(), warrantyStart: date.optional(), warrantyEnd: date.optional(), expectedLifespanYears: z.number().min(0).max(100).optional(), decommissionDate: date.optional(),
}).strict();
const technical = z.object({
  firmwareVersion: free(60).optional(), ipAddress: free(60).optional(), gateway: free(120).optional(),
  protocol: z.enum(['HL7', 'ASTM', 'DICOM', 'REST', 'WebSocket', 'TCP/IP', 'Serial', 'Modbus', 'Manufacturer SDK']).optional(),
}).strict();
const compliance = z.object({
  regulatoryRegistration: free(80).optional(), certificationExpiry: date.optional(), calibrationRequired: z.boolean(), calibrationIntervalDays: z.number().int().min(1).max(3650).optional(),
  preventiveMaintenanceIntervalDays: z.number().int().min(1).max(3650).optional(),
}).strict();
const equipment = {
  name: text(160), manufacturer: free(120).optional(), model: free(120).optional(), serialNumber: free(120).optional(),
  ownership: z.enum(['Owned', 'Leased', 'Rented', 'Donated', 'Vendor-owned', 'Government-owned']).optional(), location, procurement: procurement.optional(), lifecycle: lifecycle.optional(),
  technical: technical.optional(), compliance: compliance.optional(), assetId: z.uuid().optional(),
};

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  register: body({ id: z.uuid().optional(), category: z.enum(CATEGORIES), ...equipment }),
  update: z.object({
    params: z.object(withId).strict(), query: noQuery,
    body: z.object({ ...Object.fromEntries(Object.entries(equipment).map(([k, s]) => [k, s.optional()])), reason: free(300).optional() }).strict()
      .refine((b) => Object.entries(b).some(([k, x]) => k !== 'reason' && x !== undefined), 'Send at least one field to change'),
  }),
  detail: z.object({ params: z.object(withId).strict(), query: z.object({ parameter: z.string().max(40).optional(), hours: z.coerce.number().int().min(1).max(24 * 31).default(24) }).strict() }),
  decommission: body({ reason: text(500) }, withId),
  key: body({ label: text(80) }, withId),
  revoke: body({}, { ...withId, keyId: z.uuid() }),
  alarm: body({ severity: z.enum(SEVERITIES), category: z.enum(ALARM_CATEGORIES), description: text(1000) }, withId),
  step: body({ note: free(2000).optional(), to: free(160).optional(), resolution: free(2000).optional() }, { ...org, alarmId: z.uuid(), action: z.enum(['acknowledge', 'investigate', 'escalate', 'resolve', 'close', 'suppress']) }),
  ingest: z.object({
    params: z.object({}).strict(), query: noQuery,
    body: z.object({
      heartbeat: z.object({ latencyMs: z.number().int().min(0).max(600_000).optional() }).strict().optional(),
      machineState: z.enum(MACHINE).optional(),
      readings: z.array(z.object({ parameter: z.string().max(40), value: z.number().finite(), at: z.iso.datetime({ offset: true }).optional() }).strict()).max(200).optional(),
      events: z.array(z.object({
        type: z.enum(EVENT_TYPES), at: z.iso.datetime({ offset: true }).optional(), detail: free(1000).optional(),
        idempotencyKey: z.string().regex(/^[\w.:-]{8,120}$/), correlationId: z.string().regex(/^[\w.:-]{1,80}$/).optional(),
        // a test on an analyzer: who ran it, for whom, which order (usage sessions)
        operator: free(160).optional(), patientId: z.uuid().optional(), testName: free(160).optional(), orderId: z.uuid().optional(),
      }).strict()).max(50).optional(),
    }).strict(),
  }),
};

const part = z.object({ name: text(120), qty: z.number().positive().max(1e6), cost: z.number().min(0).max(1e12) }).strict();
const checkItem = z.object({ id: z.string().max(20), label: text(120), done: z.boolean(), note: free(500).optional() }).strict();
const versioned = (shape, params = withId) => z.object({
  params: z.object(params).strict(), query: noQuery,
  body: z.object(shape).strict().refine((b) => Object.values(b).some((x) => x !== undefined), 'Send at least one field to change'),
});
const c = {
  workOrder: body({
    id: z.uuid().optional(), type: z.enum(['Preventive', 'Corrective', 'Emergency']), severity: z.enum(['Low', 'Medium', 'High', 'Critical']), description: text(2000),
    failureCategory: free(80).optional(), scheduledFor: date.optional(), technician: free(160).optional(),
  }, withId),
  updateWorkOrder: versioned({
    status: z.enum(['Scheduled', 'In Progress', 'Awaiting Parts', 'Testing', 'Completed', 'Cancelled']).optional(), technician: free(160).optional(), scheduledFor: date.optional(),
    checklist: z.array(checkItem).max(40).optional(), partsUsed: z.array(part).max(50).optional(), diagnosis: free(2000).optional(), correctiveAction: free(2000).optional(),
    laborCost: z.number().min(0).max(1e12).optional(), downtimeMinutes: z.number().int().min(0).max(525_600).optional(), returnToServiceTested: z.boolean().optional(),
    returnToServiceNote: free(1000).optional(), cancelReason: free(500).optional(), failureCategory: free(80).optional(),
  }),
  calibration: body({ id: z.uuid().optional(), scheduledFor: date, technician: free(160).optional(), vendor: free(160).optional() }, withId),
  updateCalibration: versioned({
    status: z.enum(['In Progress', 'Completed', 'Cancelled']).optional(), scheduledFor: date.optional(), technician: free(160).optional(), vendor: free(160).optional(), standardsUsed: free(500).optional(),
    result: z.enum(['Pass', 'Fail']).optional(), certificateNumber: free(80).optional(), certificateExpiry: date.optional(), notes: free(2000).optional(), cancelReason: free(500).optional(),
  }),
  consumable: body({
    id: z.uuid().optional(), name: text(160), lotNumber: text(80), expiryDate: z.iso.date(), unit: text(30), quantityOnHand: z.number().int().min(0).max(1e7),
    reorderThreshold: z.number().int().min(0).max(1e7).optional(), costPerUnit: z.number().min(0).max(1e12).optional(), supplier: free(160).optional(),
  }, withId),
  adjust: body({ quantityDelta: z.number().int().min(-1e7).max(1e7).refine((n) => n !== 0, 'The change cannot be zero'), reason: z.enum(['Wastage', 'Expired — discarded', 'Test']).default('Wastage') }, withId),
  warranty: body({ provider: text(160), start: z.iso.date(), end: z.iso.date(), coverage: text(1000), contactName: free(120).optional(), contactPhone: free(30).optional(), slaHours: z.number().int().positive().max(8760).optional() }, withId),
  claim: body({ id: z.uuid().optional(), issue: text(2000), claimNumber: free(80).optional(), relatedWorkOrderId: z.uuid().optional() }, withId),
  updateClaim: versioned({
    status: z.enum(['Approved', 'In Repair', 'Rejected', 'Completed']).optional(), claimNumber: free(80).optional(), repairedUnderWarranty: z.boolean().optional(),
    costRecovered: z.number().min(0).max(1e12).optional(), resolutionNote: free(2000).optional(),
  }),
};

export const scadaRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, permissions, fn, status = 200) => scadaRoutes[method](path, check(schema), allow(...permissions), handle(async (req, res) => send(res, await fn(req), status)));
r('get', '/', v.overview, ['equipment.read'], (req) => scada.overview(req.emr));
r('post', '/equipment', v.register, ['equipment.manage'], (req) => scada.registerEquipment(req.emr, req.body), 201);
scadaRoutes.patch('/equipment/:id', check(v.update), allow('equipment.manage'), handle(async (req, res) => send(res, await scada.updateEquipment(req.emr, req.params.id, requireVersion(req), req.body))));
r('get', '/equipment/:id', v.detail, ['equipment.read'], (req) => scada.equipmentDetail(req.emr, req.params.id, req.query));
r('post', '/equipment/:id/decommission', v.decommission, ['equipment.manage'], (req) => scada.decommission(req.emr, req.params.id, req.body));
r('post', '/equipment/:id/device-keys', v.key, ['equipment.manage'], (req) => scada.issueDeviceKey(req.emr, req.params.id, req.body), 201);
r('post', '/equipment/:id/device-keys/:keyId/revoke', v.revoke, ['equipment.manage'], (req) => scada.revokeDeviceKey(req.emr, req.params.id, req.params.keyId));
r('post', '/equipment/:id/alarms', v.alarm, ['equipment.report'], (req) => scada.raiseAlarm(req.emr, req.params.id, req.body), 201);
// acknowledging and investigating is for anyone who reports faults; the rest is the engineers'
scadaRoutes.post('/alarms/:alarmId/:action', check(v.step), (req, res, next) => allow(['acknowledge', 'investigate'].includes(req.params.action) ? 'equipment.report' : 'equipment.manage')(req, res, next),
  handle(async (req, res) => send(res, await scada.stepAlarm(req.emr, req.params.alarmId, requireVersion(req), req.params.action, req.body))));

// Devices: their own key, their own rate limit (one noisy device never throttles another).
export const scadaIngestRoutes = express.Router();
scadaIngestRoutes.post('/', rateLimit({
  windowMs: 60_000, limit: 600, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: (req) => /^Device\s+sdk\.[^.]+\.([^.]+)\./i.exec(req.headers.authorization ?? '')?.[1] ?? 'anonymous',
}), check(v.ingest), handle(async (req, res) => send(res, await scada.ingest(req.headers.authorization, req.body), 202)));

// Looking after the equipment (scada.care.service.js): reading needs equipment.read; a corrective work
// order can be raised by anyone who reports faults; everything else is the engineers'.
r('get', '/care', v.overview, ['equipment.read'], (req) => care.careOverview(req.emr));
r('post', '/equipment/:id/work-orders', c.workOrder, ['equipment.report', 'equipment.manage'], (req) => {
  if (req.body.type === 'Preventive' && !req.emr.permissions.includes('equipment.manage')) throw new EmrError('PERMISSION_DENIED', { message: 'Preventive work orders are scheduled by engineers.' });
  return care.createWorkOrder(req.emr, req.params.id, req.body);
}, 201);
scadaRoutes.patch('/work-orders/:id', check(c.updateWorkOrder), allow('equipment.manage'), handle(async (req, res) => send(res, await care.updateWorkOrder(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/equipment/:id/calibrations', c.calibration, ['equipment.manage'], (req) => care.scheduleCalibration(req.emr, req.params.id, req.body), 201);
scadaRoutes.patch('/calibrations/:id', check(c.updateCalibration), allow('equipment.manage'), handle(async (req, res) => send(res, await care.updateCalibration(req.emr, req.params.id, requireVersion(req), req.body))));
r('post', '/equipment/:id/consumables', c.consumable, ['equipment.manage'], (req) => care.registerConsumable(req.emr, req.params.id, req.body), 201);
scadaRoutes.post('/consumables/:id/adjust', check(c.adjust), allow('equipment.manage'), handle(async (req, res) => send(res, await care.adjustConsumable(req.emr, req.params.id, requireVersion(req), req.body))));
scadaRoutes.put('/equipment/:id/warranty', check(c.warranty), allow('equipment.manage'), handle(async (req, res) => send(res, await care.setWarranty(req.emr, req.params.id, req.body))));
r('post', '/equipment/:id/warranty-claims', c.claim, ['equipment.manage'], (req) => care.raiseClaim(req.emr, req.params.id, req.body), 201);
scadaRoutes.patch('/warranty-claims/:id', check(c.updateClaim), allow('equipment.manage'), handle(async (req, res) => send(res, await care.updateClaim(req.emr, req.params.id, requireVersion(req), req.body))));
