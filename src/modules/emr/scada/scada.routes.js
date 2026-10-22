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
import { CATEGORIES } from './scada.params.js';
import * as scada from './scada.service.js';

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
      }).strict()).max(50).optional(),
    }).strict(),
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
