// The modules each Sabi product is made of — the same keys the web app uses (src/platform/entitlements.ts).
// The organization's package decides which PRODUCTS it holds; within a product it holds, the organization
// may switch a module (or a submodule) off and on again. A core module can't be switched off.
//
// `api` lists the paths each module owns, relative to its product's tenant router (/api/v1/<product>/
// organizations/:id). A path owned by no module (patients, encounters, people, the ledger, settings…) is
// shared and never switched off. `:` matches any one segment.

export const PRODUCT_KEYS = ['emr', 'workforce', 'accounting'];

export const MODULES = [
  // ---- EMR ----
  { key: 'emr.clinical', product: 'emr', label: 'Clinical', core: true },
  { key: 'emr.wards', product: 'emr', label: 'In-patient & Wards', api: ['/wards', '/beds', '/admissions', '/ward-rounds', '/encounters/:/admission'] },
  { key: 'emr.procedures', product: 'emr', label: 'Procedures', api: ['/procedures'] },
  { key: 'emr.laboratory', product: 'emr', label: 'Laboratory', api: ['/lab', '/encounters/:/lab-orders'] },
  { key: 'emr.pharmacy', product: 'emr', label: 'Pharmacy', api: ['/pharmacy', '/encounters/:/prescriptions'] },
  { key: 'emr.radiology', product: 'emr', label: 'Radiology', api: ['/imaging'] },
  { key: 'emr.mch', product: 'emr', label: 'Maternal & Child Health', api: ['/antenatal', '/deliveries', '/births', '/postnatal', '/immunizations', '/family-planning', '/nutrition'] },
  { key: 'emr.programs', product: 'emr', label: 'Public-health Programs', api: ['/programmes', '/referrals', '/surveillance', '/outreach'] },
  { key: 'emr.billing', product: 'emr', label: 'Patient Billing', api: ['/billing'] },
  { key: 'emr.operations', product: 'emr', label: 'Facility Operations', api: ['/equipment', '/stores', '/reports'] },
  { key: 'emr.equipmentScada', product: 'emr', label: 'Equipment Intelligence & SCADA', api: ['/scada'] },
  // ---- Workforce ----
  { key: 'workforce.core', product: 'workforce', label: 'People & Organisation', core: true },
  {
    key: 'workforce.time', product: 'workforce', label: 'Time & Attendance', api: ['/time'],
    submodules: [
      { key: 'workforce.time.scheduling', label: 'Scheduling', api: ['/time/schedules', '/time/assignments', '/time/blocks', '/time/policies'] },
      { key: 'workforce.time.attendance', label: 'Attendance', api: ['/time/attendance'] },
      { key: 'workforce.time.timesheets', label: 'Timesheets', api: ['/time/timesheets', '/time/periods', '/time/amendments', '/time/overtime'] },
      { key: 'workforce.time.leave', label: 'Holiday & Leave', api: ['/time/leave', '/time/holidays', '/time/holiday-work'] },
    ],
  },
  { key: 'workforce.recruitment', product: 'workforce', label: 'Recruitment & Talent', api: ['/hiring/requisitions', '/hiring/candidates', '/hiring/interviews', '/hiring/talent-pool', '/hiring/vacancies', '/hiring/offer-letter-template'] },
  { key: 'workforce.onboarding', product: 'workforce', label: 'Onboarding & Offboarding', api: ['/hiring/onboarding', '/hiring/offboarding'] },
  { key: 'workforce.performance', product: 'workforce', label: 'Performance', api: ['/careers/objectives', '/careers/employee-objectives', '/careers/feedback', '/careers/meetings', '/careers/periods'] },
  { key: 'workforce.movements', product: 'workforce', label: 'Promotions & Transfers', api: ['/careers/promotions', '/careers/transfers'] },
  { key: 'workforce.payroll', product: 'workforce', label: 'Payroll & Loans', api: ['/payroll'] },
  { key: 'workforce.relations', product: 'workforce', label: 'Employee Relations', api: ['/services/queries', '/services/tickets', '/services/faqs', '/services/faq-categories'] },
  { key: 'workforce.assets', product: 'workforce', label: 'Company Assets', api: ['/services/assets', '/services/allocations', '/services/asset-categories', '/services/asset-requests'] },
  { key: 'workforce.reports', product: 'workforce', label: 'Workforce Reports', core: true },
  // ---- Accounting ----
  { key: 'accounting.gl', product: 'accounting', label: 'General Ledger', core: true },
  { key: 'accounting.ar', product: 'accounting', label: 'Accounts Receivable', api: ['/receivables'] },
  { key: 'accounting.ap', product: 'accounting', label: 'Accounts Payable', api: ['/payables'] },
  { key: 'accounting.banking', product: 'accounting', label: 'Banking', api: ['/banking'] },
  { key: 'accounting.expenses', product: 'accounting', label: 'Expenses', api: ['/expenses'] },
  { key: 'accounting.assets', product: 'accounting', label: 'Fixed Assets', api: ['/fixed-assets'] },
  { key: 'accounting.inventory', product: 'accounting', label: 'Inventory Accounting', api: ['/inventory'] },
  { key: 'accounting.budgets', product: 'accounting', label: 'Budgets & Forecasts', api: ['/planning/budgets', '/planning/cost-centres', '/projects'] },
  { key: 'accounting.tax', product: 'accounting', label: 'Tax', api: ['/planning/tax-returns'] },
  { key: 'accounting.reports', product: 'accounting', label: 'Financial Reporting', core: true },
  { key: 'accounting.integrations', product: 'accounting', label: 'Integrations', api: ['/integrations'] },
];

const SWITCHABLE = new Map();
for (const m of MODULES) {
  if (!m.core) SWITCHABLE.set(m.key, { module: m });
  for (const s of m.submodules ?? []) SWITCHABLE.set(s.key, { module: m, submodule: s });
}
/** The module (and submodule) behind a key that can be switched off, or undefined. */
export const switchable = (key) => SWITCHABLE.get(key);

const covers = (prefix, segments) => {
  const parts = prefix.split('/').filter(Boolean);
  return parts.length <= segments.length && parts.every((p, i) => p === ':' || p === segments[i]);
};

/** Every switchable key that owns `path` within `product` (a module and, under it, a submodule). */
export function keysForPath(product, path) {
  const segments = path.split('?')[0].split('/').filter(Boolean);
  const keys = [];
  for (const m of MODULES) {
    if (m.product !== product || m.core) continue;
    if ((m.api ?? []).some((p) => covers(p, segments))) keys.push(m.key);
    for (const s of m.submodules ?? []) if (s.api.some((p) => covers(p, segments))) keys.push(m.key, s.key);
  }
  return [...new Set(keys)];
}
