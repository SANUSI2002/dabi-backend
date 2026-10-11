// Documents every registered route that docs/openapi.yaml does not already describe by hand.
//
// Reads the live Express route table (scripts/route-inventory.mjs) and what each route's
// middleware declares (src/docs/routeMeta.js): its zod request schema (→ JSON Schema), sign-in,
// organization / platform context, permissions, roles, MFA, and — from the handler — the
// If-Match / Idempotency-Key headers and the success status. Hand-written operations are kept as
// they are; generated ones carry `x-generated: true` and are rebuilt on every run.
//
// Usage: npm run docs:routes   (then restart the server; Swagger UI is at /api/docs)
import fs from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { listRoutes } from './route-inventory.mjs';

const SPEC = 'docs/openapi.yaml';
// The docs UI itself, and private machine callbacks that must never appear in the public reference.
const IGNORED = new Set(['get /api/openapi.json', 'get /api/docs', 'get /api/docs/', 'post /api/v1/internal/document-scans/:id/result']);
const norm = (path) => path.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '{}');
const toOpenApiPath = (path) => path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, '{$1}');

// ---- what each route declares ---------------------------------------------------------------
function describeRoute(route) {
  const metas = route.handlers.map((h) => h?.openapi).filter(Boolean);
  const schemas = metas.map((m) => m.schema).filter(Boolean);
  const handler = metas.find((m) => m.handler)?.handler ?? route.handlers.at(-1);
  const source = typeof handler === 'function' ? handler.toString() : '';
  return {
    auth: metas.some((m) => m.auth),
    emr: metas.some((m) => m.emr || m.emrTenant) || route.path.startsWith('/api/v1/emr/organizations'),
    context: metas.find((m) => m.context)?.context,
    permissions: metas.filter((m) => m.permissions).map((m) => m.permissions),
    roles: metas.flatMap((m) => m.roles ?? []),
    mfa: metas.find((m) => m.mfa)?.mfa,
    schemas,
    ifMatch: /requireVersion\(req\)/.test(source),
    idempotency: /readIdempotencyKey\(req\)/.test(source),
    created: /sendResult\(|,\s*201\)|status\(201\)/.test(source),
    noContent: /status\(204\)/.test(source),
  };
}

const jsonSchema = (schema) => {
  try {
    const out = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', target: 'draft-2020-12' });
    delete out.$schema;
    return out;
  } catch {
    return null;
  }
};

/** Path, query and body parts of the route's validators, as JSON Schema. */
function requestParts(schemas) {
  const parts = { params: {}, query: null, body: null };
  for (const schema of schemas) {
    const json = jsonSchema(schema);
    if (!json?.properties) continue;
    Object.assign(parts.params, json.properties.params?.properties ?? {});
    // The route's own validator comes last; it wins for query and body.
    if (json.properties.query) parts.query = json.properties.query;
    if (json.properties.body) parts.body = json.properties.body;
  }
  return parts;
}

const isEmpty = (schema) => !schema || (schema.type === 'object' && !Object.keys(schema.properties ?? {}).length);

// ---- naming -------------------------------------------------------------------------------
const EMR_AREAS = [
  [/\/(record|problems|allergies|medications)(\/|$)/, 'EMR · Patient record'],
  [/\/(lab-orders|lab)(\/|$)/, 'EMR · Laboratory'],
  [/\/(prescriptions|pharmacy)(\/|$)/, 'EMR · Pharmacy'],
  [/\/(admission|admissions|wards|beds)(\/|$)/, 'EMR · Admissions and wards'],
  [/\/billing(\/|$)/, 'EMR · Billing'],
  [/\/queue(\/|$)/, 'EMR · Queue'],
  [/\/appointments(\/|$)/, 'EMR · Appointments'],
  [/\/imaging(\/|$)/, 'EMR · Radiology'],
  [/\/procedures(\/|$)/, 'EMR · Procedures'],
  [/\/dashboard(\/|$)/, 'EMR · Dashboard'],
  [/\/staff(\/|$)/, 'EMR · Staff'],
  [/\/audit-events(\/|$)/, 'EMR · Audit'],
  [/\/webhooks(\/|$)/, 'EMR · Webhooks'],
  [/\/telehealth(\/|$)/, 'EMR · Telehealth'],
  [/\/encounters(\/|$)/, 'EMR · Encounters'],
  [/\/patients(\/|$)/, 'EMR · Patients'],
];
const MODULE_TAGS = {
  auth: 'Auth', platform: 'Platform', applications: 'Organization applications', doctors: 'Doctor onboarding',
  'professional-care': 'Professional Care', 'professional-schedule': 'Professional Schedule', 'doctor-appointments': 'Doctor Appointments',
  whatsapp: 'WhatsApp', internal: 'Internal', catalog: 'Catalog', emr: 'EMR', 'consultation-notes': 'Consultation Notes',
  'medication-schedules': 'Medication Schedules', waitlist: 'Waitlist', audit: 'Audit',
};
const TAG_DESCRIPTIONS = {
  'Command Centre': 'Sabi platform operations: pricing, oversight, finance, support and audit. Platform staff only; every action is permission-checked and audited.',
  'EMR · Patients': 'Hospital patient registry (tenant-scoped, row-level security).',
  'EMR · Patient record': 'A patient’s longitudinal chart, problem list, allergies and medicines.',
  'EMR · Encounters': 'Visits: check-in, lifecycle, clinical notes, vital signs and diagnoses.',
  'EMR · Queue': 'The clinic queue across stations.',
  'EMR · Laboratory': 'Lab orders, specimens, results, verification, critical values.',
  'EMR · Pharmacy': 'Prescribing, pharmacist review, dispensing, formulary and stock.',
  'EMR · Admissions and wards': 'Wards, beds, admissions, transfers, discharge, nursing and MAR.',
  'EMR · Billing': 'Prices, charges, invoices, payments, statements and reconciliation.',
  'EMR · Appointments': 'Hospital bookings and Sabi app appointment requests.',
  'EMR · Radiology': 'Imaging studies: request, perform, report, verify, addenda.',
  'EMR · Procedures': 'Minor / outpatient procedures with the safety checklist and signed note.',
  'EMR · Dashboard': 'The workspace home screen.',
  'EMR · Staff': 'Colleague pickers (names only).',
  'EMR · Audit': 'The hospital’s EMR access trail.',
  'EMR · Webhooks': 'Outbound event subscriptions.',
  'EMR · Telehealth': 'Telemedicine designation and handoff.',
};

function tagFor(path) {
  if (path.startsWith('/api/v1/emr/organizations/')) {
    const rest = path.slice('/api/v1/emr/organizations/:organizationId'.length);
    // The deepest matching area wins (e.g. /encounters/{id}/prescriptions is Pharmacy).
    const hits = EMR_AREAS.map(([pattern, tag]) => [rest.search(pattern), tag]).filter(([at]) => at >= 0);
    return hits.sort((a, b) => b[0] - a[0])[0]?.[1] ?? 'EMR';
  }
  const segment = path.split('/')[3] ?? '';
  return MODULE_TAGS[segment] ?? segment.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

const ACTIONS = new Set(['perform', 'sign', 'verify', 'cancel', 'schedule', 'consent', 'check-in', 'no-show', 'collect', 'dispense', 'approve', 'reject',
  'confirm', 'discharge', 'transfer', 'start', 'finish', 'recovery', 'follow-up', 'pre-procedure', 'capture', 'void', 'reverse', 'call-next', 'close',
  'deactivate', 'reactivate', 'link-account', 'acknowledge', 'communicate', 'return', 'amend', 'report', 'entered-in-error', 'comparison', 'checklist',
  'adjust', 'complete', 'resend', 'revoke', 'refresh', 'login', 'logout', 'verify-email', 'accept', 'decline', 'test', 'rotate', 'retry', 'submit',
  'publish', 'archive', 'suspend', 'restore', 'switch', 'enrol', 'enroll', 'disable', 'enable', 'issue', 'release', 'assign', 'unassign', 'decide', 'preview']);
const IRREGULAR = { addenda: 'addendum', analyses: 'analysis', statuses: 'status', diagnoses: 'diagnosis', batches: 'batch', 'audit-events': 'audit event' };
const ACRONYMS = { mar: 'MAR', mfa: 'MFA', totp: 'TOTP', emr: 'EMR', otp: 'OTP' };
const words = (segment) => segment.split('-').map((w) => ACRONYMS[w] ?? w).join(' ');
const singular = (segment) => IRREGULAR[segment] ?? (/(ss|us)$/.test(segment) ? words(segment) : words(segment).replace(/ies$/, 'y').replace(/s$/, ''));
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);

function summaryFor(method, path) {
  const parts = path.split('/').filter(Boolean).slice(2); // drop api, v1
  const tail = parts.slice(parts[0] === 'emr' && parts[1] === 'organizations' ? 3 : 0);
  const last = tail.at(-1) ?? '';
  const lastIsParam = last.startsWith(':');
  const statics = tail.filter((s) => !s.startsWith(':'));
  const resource = statics.at(-1) ?? parts[0];
  const owner = statics.at(-2);
  if (lastIsParam) {
    const thing = singular(resource);
    return sentence({ get: `get ${thing}`, patch: `update ${thing}`, put: `replace ${thing}`, delete: `delete ${thing}` }[method] ?? `${method} ${thing}`);
  }
  const prevIsParam = tail.at(-2)?.startsWith(':');
  const plural = (segment) => (/s$/.test(segment) && !/(ss|us)$/.test(segment)) || Boolean(IRREGULAR[segment]);
  if (last === 'entered-in-error') return sentence(`mark ${singular(owner ?? 'record')} entered in error`);
  if (ACTIONS.has(last)) return sentence(`${words(last)}${owner ? ` ${singular(owner)}` : ''}`);
  if (method === 'get') return sentence(plural(last) ? `list ${words(last)}${prevIsParam && owner ? ` of ${singular(owner)}` : ''}` : `get ${words(last)}${owner && prevIsParam ? ` of ${singular(owner)}` : ''}`);
  if (method === 'post') return sentence(plural(last) ? `create ${singular(last)}${prevIsParam && owner ? ` for ${singular(owner)}` : ''}` : prevIsParam && owner ? `record ${words(last)} for ${singular(owner)}` : `${words(last)}${owner ? ` ${singular(owner)}` : ''}`);
  if (method === 'put') return sentence(`set ${words(last)}${owner ? ` of ${singular(owner)}` : ''}`);
  if (method === 'patch') return sentence(`update ${words(last)}`);
  if (method === 'delete') return sentence(`remove ${words(last)}`);
  return sentence(`${method} ${words(last)}`);
}

function descriptionFor(info) {
  const lines = [];
  if (info.emr) lines.push('Hospital (EMR) endpoint: the bearer token must belong to an active member of `organizationId`, whose EMR licence is active. Records of other organizations are reported as not found.');
  else if (info.context === 'organization') lines.push('Requires an active organization context in the token (switch organization first).');
  else if (info.context === 'platform') lines.push('Platform staff only (no organization context).');
  for (const codes of info.permissions) lines.push(codes.length > 1 ? `Requires any of the permissions ${codes.map((c) => `\`${c}\``).join(', ')}.` : `Requires the permission \`${codes[0]}\`.`);
  if (info.roles.length) lines.push(`Requires the role ${info.roles.map((r) => `\`${r}\``).join(', ')}.`);
  if (info.mfa === 'required') lines.push('Requires a recent multi-factor verification.');
  if (info.mfa === 'if-enrolled') lines.push('Requires a recent multi-factor verification when the account has MFA enrolled.');
  if (info.ifMatch) lines.push('Optimistic concurrency: send the record’s current version in `If-Match` (e.g. `W/"3"`). A stale version returns 412 with the current version in `ETag`.');
  if (info.idempotency) lines.push('Send an `Idempotency-Key` to make retries safe: the same key returns the first result (`Idempotent-Replayed: true`).');
  return lines.join('\n\n') || undefined;
}

// Where the path alone does not say it well, or the route reads its input without a validator.
const binary = (description) => ({ required: true, description, content: Object.fromEntries(['application/pdf', 'image/jpeg', 'image/png'].map((type) => [type, { schema: { type: 'string', contentEncoding: 'binary' } }])) });
const OVERRIDES = {
  'put /api/v1/doctors/applications/{}/credentials/{}': { summary: 'Upload a credential document', requestBody: binary('The file itself (PDF, JPEG or PNG, up to 5 MB), with its Content-Type. Scanned for malware before review.') },
  'put /api/v1/applications/{}/evidence/{}': { summary: 'Upload evidence for an organization application', requestBody: binary('The file itself (PDF, JPEG or PNG) for the named requirement, with its Content-Type. Scanned for malware before review.') },
  'post /api/v1/whatsapp/simulator/reply': { summary: 'Simulate a WhatsApp reply (development only)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: false, required: ['from'], properties: { from: { type: 'string', minLength: 6, maxLength: 24 }, payload: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 1000 } } } } } } },
  'post /api/v1/whatsapp/simulator/status': { summary: 'Simulate a WhatsApp delivery status (development only)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['messageId', 'status'], properties: { messageId: { type: 'string' }, status: { type: 'string', enum: ['sent', 'delivered', 'read', 'failed'] } } } } } } },
  'get /api/v1/whatsapp/simulator/messages': { summary: 'List simulated WhatsApp messages (development only)' },
  'post /api/v1/auth/sessions/logout-others': { summary: 'Sign out all other sessions' },
  'post /api/v1/auth/sessions/logout-all': { summary: 'Sign out all sessions' },
  'get /api/v1/auth/mfa/status': { summary: 'Get MFA status' },
  'get /api/v1/doctors/me': { summary: 'Get my doctor application' },
  'get /api/v1/auth/organizations/{}/emr-access': { summary: 'Get EMR access for an organization' },
  'get /api/v1/emr/organizations/{}/pharmacy/formulary': { summary: 'List the formulary' },
  'post /api/v1/emr/organizations/{}/pharmacy/formulary': { summary: 'Add a formulary item' },
  'get /api/v1/emr/organizations/{}/pharmacy/stock': { summary: 'List stock levels' },
  'get /api/v1/emr/organizations/{}/queue': { summary: 'List the queue' },
  'get /api/v1/emr/organizations/{}/staff': { summary: 'List colleagues with a permission' },
  'post /api/v1/emr/organizations/{}/beds/{}/status': { summary: 'Set bed status' },
  'post /api/v1/emr/organizations/{}/procedures/{}/pre-procedure': { summary: 'Move procedure to pre-procedure' },
  'put /api/v1/emr/organizations/{}/procedures/{}/checklist/{}': { summary: 'Tick or excuse a safety checklist item' },
  'put /api/v1/emr/organizations/{}/imaging/studies/{}/comparison': { summary: 'Set the prior study to compare with' },
  'get /api/v1/emr/organizations/{}/patients/{}/record': { summary: 'Get patient record (whole chart)' },
  'post /api/v1/emr/organizations/{}/billing/encounters/{}/capture': { summary: 'Capture charges for a visit' },
  'post /api/v1/emr/organizations/{}/encounters/{}/admission': { summary: 'Admit the patient from a visit' },
  'post /api/v1/emr/organizations/{}/admissions/{}/mar': { summary: 'Record a medication administration' },
  'get /api/v1/emr/organizations/{}/admissions/{}/mar': { summary: 'Get the medication administration record' },
  'post /api/v1/emr/organizations/{}/admissions/{}/nursing': { summary: 'Record nursing observations' },
  'get /api/v1/emr/organizations/{}/admissions/{}/nursing': { summary: 'Get the nursing flowsheet' },
  'post /api/v1/emr/organizations/{}/appointments/{}/no-show': { summary: 'Mark appointment as no-show' },
  'post /api/v1/emr/organizations/{}/appointments/{}/check-in': { summary: 'Check the patient in for an appointment' },
  'get /api/v1/emr/internal/metrics': { summary: 'EMR service metrics (platform operations)' },
  'get /api/v1/command-centre/pricing/delivery': { summary: 'Get delivery pricing: the version in force, scheduled and past versions, and road-routing status' },
  'post /api/v1/command-centre/pricing/delivery': { summary: 'Create a delivery pricing version (now or scheduled), with a reason' },
  'post /api/v1/command-centre/pricing/delivery/{}/cancel': { summary: 'Cancel a scheduled delivery pricing version' },
  'post /api/v1/command-centre/pricing/delivery/simulate': { summary: 'Simulate a delivery quote with the live or a draft rule set (saves nothing)' },
};

// ---- responses ----------------------------------------------------------------------------
const EMR_ERROR = {
  type: 'object',
  required: ['status', 'error'],
  properties: {
    status: { const: 'error' },
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', examples: ['VALIDATION_FAILED', 'PERMISSION_DENIED', 'PATIENT_NOT_FOUND', 'INVALID_STATE', 'VERSION_CONFLICT'] },
        message: { type: 'string' },
        details: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, message: { type: 'string' } } } },
        requestId: { type: 'string' },
      },
    },
  },
};
const emrResponse = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/EmrError' } } } });
const EMR_RESPONSES = {
  EmrBadRequest: emrResponse('VALIDATION_FAILED: the request does not match the contract (field paths in `details`).'),
  EmrUnauthorized: emrResponse('Sign-in required or the token is invalid / expired.'),
  EmrForbidden: emrResponse('Not a member of this organization, EMR not enabled, or the role lacks the permission.'),
  EmrNotFound: emrResponse('Not found — also returned for another organization’s records.'),
  EmrConflict: emrResponse('The record is not in a state that allows this (e.g. INVALID_STATE) or a uniqueness rule was hit.'),
  EmrPreconditionFailed: emrResponse('VERSION_CONFLICT: someone changed the record first; reload and retry (current version in `ETag`).'),
  EmrPreconditionRequired: emrResponse('PRECONDITION_REQUIRED: the `If-Match` header is missing.'),
  EmrRateLimited: emrResponse('Too many requests for this organization.'),
  EmrServerError: emrResponse('Unexpected error (no internal detail; quote `requestId`).'),
};

function responsesFor(info, method, hasPathParams, hasInput) {
  const code = info.noContent ? '204' : info.created ? '201' : '200';
  const success = code === '204'
    ? { description: 'Done; no response body.' }
    : { description: info.created && info.idempotency ? 'Created (200 with `Idempotent-Replayed: true` when a key is repeated).' : 'Success.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Success' } } } };
  const out = { [code]: success };
  const ref = (name) => ({ $ref: `#/components/responses/${name}` });
  if (info.emr) {
    if (hasInput || hasPathParams) out['400'] = ref('EmrBadRequest');
    out['401'] = ref('EmrUnauthorized');
    out['403'] = ref('EmrForbidden');
    if (hasPathParams) out['404'] = ref('EmrNotFound');
    if (method !== 'get') out['409'] = ref('EmrConflict');
    if (info.ifMatch) { out['412'] = ref('EmrPreconditionFailed'); out['428'] = ref('EmrPreconditionRequired'); }
    out['429'] = ref('EmrRateLimited');
    out['500'] = ref('EmrServerError');
    return out;
  }
  if (hasInput || hasPathParams) out['400'] = ref('BadRequest');
  if (info.auth) out['401'] = ref('Unauthorized');
  if (info.permissions.length || info.roles.length || info.context) out['403'] = { description: 'Access denied', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  if (hasPathParams) out['404'] = ref('NotFound');
  if (method !== 'get') out['409'] = ref('Conflict');
  out['429'] = ref('RateLimited');
  out['500'] = ref('ServerError');
  return out;
}

// ---- build --------------------------------------------------------------------------------
const spec = YAML.parse(fs.readFileSync(SPEC, 'utf8'));
for (const [path, ops] of Object.entries(spec.paths ?? {})) {
  for (const [method, op] of Object.entries(ops)) if (op?.['x-generated']) delete ops[method];
  if (!Object.keys(ops).length) delete spec.paths[path];
}
const documented = new Set(Object.entries(spec.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${norm(path)}`)));

const seen = new Set();
const usedTags = new Set();
let generated = 0;
for (const route of listRoutes()) {
  const key = `${route.method} ${norm(route.path)}`;
  if (IGNORED.has(`${route.method} ${route.path}`) || documented.has(key) || seen.has(key)) continue;
  seen.add(key);
  const info = describeRoute(route);
  const parts = requestParts(info.schemas);
  const pathParams = [...route.path.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)].map(([, name]) => name);
  const parameters = [
    ...pathParams.map((name) => ({ name, in: 'path', required: true, schema: parts.params[name] ?? { type: 'string' } })),
    ...Object.entries(parts.query?.properties ?? {}).map(([name, schema]) => ({ name, in: 'query', required: (parts.query.required ?? []).includes(name), schema })),
    ...(info.ifMatch ? [{ name: 'If-Match', in: 'header', required: true, description: 'The record version from your last read, e.g. W/"3".', schema: { type: 'string', examples: ['W/"3"'] } }] : []),
    ...(info.idempotency ? [{ name: 'Idempotency-Key', in: 'header', required: false, description: 'Client-chosen unique key (e.g. a UUID) that makes retries return the first result.', schema: { type: 'string', maxLength: 200 } }] : []),
  ];
  const hasBody = route.method !== 'get' && !isEmpty(parts.body);
  const tag = tagFor(route.path);
  usedTags.add(tag);
  const operation = {
    tags: [tag],
    summary: summaryFor(route.method, route.path),
    description: descriptionFor(info),
    operationId: `${route.method}_${route.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
    security: info.auth || info.emr ? [{ bearerAuth: [] }] : [],
    ...(parameters.length ? { parameters } : {}),
    ...(hasBody ? { requestBody: { required: true, content: { 'application/json': { schema: parts.body } } } } : {}),
    responses: responsesFor(info, route.method, pathParams.length > 0, hasBody || !isEmpty(parts.query)),
    'x-generated': true,
  };
  Object.assign(operation, OVERRIDES[key] ?? {});
  const openPath = toOpenApiPath(route.path);
  spec.paths[openPath] ??= {};
  spec.paths[openPath][route.method] = Object.fromEntries(Object.entries(operation).filter(([, v]) => v !== undefined));
  generated += 1;
}

spec.components ??= {};
spec.components.schemas = { ...spec.components.schemas, EmrError: EMR_ERROR };
spec.components.responses = { ...spec.components.responses, ...EMR_RESPONSES };
const tags = new Map((spec.tags ?? []).map((t) => [t.name, t]));
for (const name of usedTags) if (!tags.has(name)) tags.set(name, { name, description: TAG_DESCRIPTIONS[name] ?? `${name} endpoints.` });
// Only tags that still have operations (a removed route must not leave an empty section).
const tagsInUse = new Set(Object.values(spec.paths).flatMap((ops) => Object.values(ops).flatMap((op) => op.tags ?? [])));
spec.tags = [...tags.values()].filter((t) => tagsInUse.has(t.name));
// Keep paths in a stable, readable order.
spec.paths = Object.fromEntries(Object.entries(spec.paths).sort(([a], [b]) => a.localeCompare(b)));

fs.writeFileSync(SPEC, YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false }));
const total = Object.values(spec.paths).reduce((n, ops) => n + Object.keys(ops).length, 0);
console.log(`docs/openapi.yaml: ${total} operations (${generated} generated from the routes, ${total - generated} written by hand).`);
process.exit(0);
