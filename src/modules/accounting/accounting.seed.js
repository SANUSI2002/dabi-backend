// Starter accounting configuration each organization begins with (the same chart, templates, approval
// rules and exchange rates the Accounting screens ship), seeded once and then edited by the organization.

// [number, name, type, subtype] — the starter chart (balances start at zero)
export const STARTER_CHART = [
  // ---- Assets 1000–1999 ----
  [1000, "Cash on Hand", "asset", "cash"],
  [1010, "Bank — Current Account", "asset", "bank"],
  [1020, "Bank — Domiciliary (USD)", "asset", "bank"],
  [1090, "Undeposited Funds", "asset", "current_asset"],
  [1100, "Accounts Receivable — Patients", "asset", "accounts_receivable"],
  [1110, "Accounts Receivable — NHIS", "asset", "accounts_receivable"],
  [1120, "Accounts Receivable — HMOs", "asset", "accounts_receivable"],
  [1150, "Intercompany Receivable", "asset", "current_asset"],
  [1200, "Drug & Consumables Inventory", "asset", "inventory"],
  [1210, "Medical Supplies Inventory", "asset", "inventory"],
  [1300, "Prepaid Expenses", "asset", "current_asset"],
  [1400, "Staff Advances & Loans Receivable", "asset", "current_asset"],
  [1500, "Property, Plant & Equipment", "asset", "fixed_asset"],
  [1510, "Medical Equipment", "asset", "fixed_asset"],
  [1580, "Assets Under Construction", "asset", "fixed_asset"],
  [1590, "Accumulated Depreciation", "asset", "contra_asset"],

  // ---- Liabilities 2000–2999 ----
  [2000, "Accounts Payable — Trade", "liability", "accounts_payable"],
  [2100, "Accrued Expenses", "liability", "current_liability"],
  [2110, "Staff Reimbursements Payable", "liability", "current_liability"],
  [2120, "Salaries & Wages Payable", "liability", "current_liability"],
  [2150, "Intercompany Payable", "liability", "current_liability"],
  [2200, "VAT Payable", "liability", "tax_payable"],
  [2210, "Withholding Tax Payable", "liability", "tax_payable"],
  [2220, "Health Levy Payable", "liability", "tax_payable"],
  [2300, "PAYE Payable", "liability", "tax_payable"],
  [2310, "Pension Payable", "liability", "tax_payable"],
  [2320, "NHF Payable", "liability", "tax_payable"],
  [2400, "Deferred Revenue", "liability", "current_liability"],
  [2600, "Loans Payable", "liability", "long_term_liability"],

  // ---- Equity 3000–3999 ----
  [3000, "Owner's Capital", "equity", "equity"],
  [3100, "Drawings", "equity", "equity"],
  [3200, "Retained Earnings", "equity", "retained_earnings"],
  [3300, "Revaluation Reserve", "equity", "equity"],
  [3900, "Opening Balance Equity", "equity", "equity"],

  // ---- Revenue 4000–4999 ----
  [4000, "Consultation Revenue", "revenue", "operating_revenue"],
  [4010, "Laboratory Revenue", "revenue", "operating_revenue"],
  [4020, "Pharmacy Revenue", "revenue", "operating_revenue"],
  [4030, "Procedure & Theatre Revenue", "revenue", "operating_revenue"],
  [4040, "Admission & Bed Revenue", "revenue", "operating_revenue"],
  [4050, "Radiology & Imaging Revenue", "revenue", "operating_revenue"],
  [4100, "Other Income", "revenue", "other_income"],
  [4110, "Foreign Exchange Gain", "revenue", "other_income"],
  [4900, "Discounts & Waivers", "revenue", "contra_revenue"],

  // ---- Cost of goods sold 5000–5099 ----
  [5000, "Cost of Drugs Dispensed", "cogs", "cost_of_goods_sold"],
  [5010, "Cost of Medical Supplies Used", "cogs", "cost_of_goods_sold"],

  // ---- Operating expenses 5100–5999 ----
  [5100, "Salaries & Wages", "expense", "payroll_expense"],
  [5110, "Employer Pension Contribution", "expense", "payroll_expense"],
  [5120, "Staff Welfare & Training", "expense", "operating_expense"],
  [5200, "Rent", "expense", "operating_expense"],
  [5210, "Utilities — Power & Water", "expense", "operating_expense"],
  [5220, "Diesel & Generator Running", "expense", "operating_expense"],
  [5230, "Repairs & Maintenance", "expense", "operating_expense"],
  [5240, "Cleaning & Sanitation", "expense", "operating_expense"],
  [5250, "Medical Waste Disposal", "expense", "operating_expense"],
  [5300, "Office & Admin Supplies", "expense", "operating_expense"],
  [5310, "Telephone & Internet", "expense", "operating_expense"],
  [5400, "Professional Fees", "expense", "operating_expense"],
  [5500, "Depreciation Expense", "expense", "depreciation_expense"],
  [5520, "Impairment Loss", "expense", "other_expense"],
  [5600, "Bank Charges", "expense", "other_expense"],
  [5610, "Foreign Exchange Loss", "expense", "other_expense"],
  [5700, "Bad Debt Expense", "expense", "other_expense"],
  [5900, "Miscellaneous Expense", "expense", "other_expense"],
];

// Control accounts are posted only by their subledger, never by hand.
export const CONTROL_SUBTYPES = ["accounts_receivable", "accounts_payable", "inventory", "contra_asset"];

const a = (number, name, type, subtype, parentNumber) => ({ number, name, type, subtype, parentNumber });
export const COA_TEMPLATES = [
  {
    id: "tmpl-hospital-ng",
    name: "Hospital / Clinic (Nigeria)",
    industry: "Healthcare",
    description: "Payer-mix receivables (NHIS / HMO / patient), pharmacy & consumables inventory, clinical service revenue lines, WHT/PAYE/pension payables. This is the chart Sabi ships with.",
    accounts: [
      a(1100, "Accounts Receivable — Patients", "asset", "accounts_receivable"),
      a(1110, "Accounts Receivable — NHIS", "asset", "accounts_receivable"),
      a(1120, "Accounts Receivable — HMO", "asset", "accounts_receivable"),
      a(1200, "Drug Inventory", "asset", "inventory"),
      a(1210, "Medical Supplies Inventory", "asset", "inventory"),
      a(2300, "PAYE Payable", "liability", "tax_payable"),
      a(2310, "Pension Payable", "liability", "current_liability"),
      a(4000, "Consultation Revenue", "revenue", "operating_revenue"),
      a(4010, "Laboratory Revenue", "revenue", "operating_revenue"),
      a(4020, "Pharmacy Revenue", "revenue", "operating_revenue"),
      a(5000, "Cost of Drugs Dispensed", "cogs", "cost_of_goods_sold"),
    ],
  },
  {
    id: "tmpl-general",
    name: "General Business",
    industry: "General trade & services",
    description: "A plain services/trading chart — trade debtors and creditors, sales and purchases, standard overhead expense lines.",
    accounts: [
      a(1000, "Cash on Hand", "asset", "cash"),
      a(1010, "Bank — Current Account", "asset", "bank"),
      a(1100, "Trade Debtors", "asset", "accounts_receivable"),
      a(1200, "Stock / Inventory", "asset", "inventory"),
      a(1500, "Property, Plant & Equipment", "asset", "fixed_asset"),
      a(1590, "Accumulated Depreciation", "asset", "contra_asset"),
      a(2000, "Trade Creditors", "liability", "accounts_payable"),
      a(2200, "VAT Payable", "liability", "tax_payable"),
      a(2600, "Bank Loan", "liability", "long_term_liability"),
      a(3000, "Owner's Capital", "equity", "equity"),
      a(3200, "Retained Earnings", "equity", "retained_earnings"),
      a(4000, "Sales Revenue", "revenue", "operating_revenue"),
      a(4100, "Other Income", "revenue", "other_income"),
      a(5000, "Cost of Sales", "cogs", "cost_of_goods_sold"),
      a(5100, "Salaries & Wages", "expense", "payroll_expense"),
      a(5200, "Rent", "expense", "operating_expense"),
      a(5300, "Utilities", "expense", "operating_expense"),
      a(5500, "Depreciation Expense", "expense", "depreciation_expense"),
    ],
  },
  {
    id: "tmpl-ngo",
    name: "NGO / Non-profit",
    industry: "Non-profit",
    description: "Fund-accounting flavour — grant & donation income, restricted vs unrestricted funds, programme vs support-cost expense lines.",
    accounts: [
      a(1000, "Cash on Hand", "asset", "cash"),
      a(1010, "Bank — Operating", "asset", "bank"),
      a(1030, "Bank — Restricted Grants", "asset", "bank"),
      a(1100, "Grants Receivable", "asset", "accounts_receivable"),
      a(2000, "Accounts Payable", "liability", "accounts_payable"),
      a(2500, "Deferred Grant Income", "liability", "current_liability"),
      a(3100, "Unrestricted Funds", "equity", "equity"),
      a(3110, "Restricted Funds", "equity", "equity"),
      a(4200, "Grant Income", "revenue", "operating_revenue"),
      a(4210, "Donations & Appeals", "revenue", "operating_revenue"),
      a(4220, "Fundraising Events", "revenue", "other_income"),
      a(5600, "Programme Costs", "expense", "operating_expense"),
      a(5610, "Support & Governance Costs", "expense", "operating_expense"),
      a(5620, "Fundraising Costs", "expense", "operating_expense"),
    ],
  },
];

export const STARTER_APPROVAL_RULES = [
  // Purchase requisitions
  { id: "ar-pr-1", docType: "Purchase Requisition", minAmount: 250_000, maxAmount: 2_000_000, approverRole: "Approver", level: 1, active: true },
  { id: "ar-pr-2", docType: "Purchase Requisition", minAmount: 2_000_000, maxAmount: null, approverRole: "Finance Controller", level: 2, active: true },
  // Bills
  { id: "ar-bill-1", docType: "Bill", minAmount: 500_000, maxAmount: 3_000_000, approverRole: "Accountant", level: 1, active: true },
  { id: "ar-bill-2", docType: "Bill", minAmount: 3_000_000, maxAmount: null, approverRole: "Finance Controller", level: 2, active: true },
  // Vendor payments
  { id: "ar-vp-1", docType: "Vendor Payment", minAmount: 1_000_000, maxAmount: null, approverRole: "Finance Controller", level: 1, active: true },
  // Expense claims
  { id: "ar-exp-1", docType: "Expense Claim", minAmount: 50_000, maxAmount: 250_000, approverRole: "Approver", level: 1, active: true },
  { id: "ar-exp-2", docType: "Expense Claim", minAmount: 250_000, maxAmount: null, approverRole: "Finance Controller", level: 2, active: true },
  // Manual journal entries
  { id: "ar-je-1", docType: "Journal Entry", minAmount: 1_000_000, maxAmount: null, approverRole: "Finance Controller", level: 1, active: true },
];

export const STARTER_FX_RATES = [
  { code: "NGN", name: "Nigerian Naira", symbol: "₦", rateToNgn: 1 },
  { code: "USD", name: "US Dollar", symbol: "$", rateToNgn: 1_580 },
  { code: "GBP", name: "Pound Sterling", symbol: "£", rateToNgn: 2_000 },
  { code: "EUR", name: "Euro", symbol: "€", rateToNgn: 1_700 },
];

// Settings a new organization starts with: numbering from 1, the standard payment terms and reminder
// ladder, and a blank company profile and tax registration for the finance team to fill in.
export const STARTER_SEQUENCES = [
  { key: "journal", label: "Journal Entry", prefix: "JE-", padding: 6, next: 1 },
  { key: "estimate", label: "Quotation / Estimate", prefix: "EST-", padding: 6, next: 1 },
  { key: "sales-order", label: "Sales Order", prefix: "SO-", padding: 6, next: 1 },
  { key: "invoice", label: "Sales Invoice", prefix: "INV-", padding: 6, next: 1 },
  { key: "sales-receipt", label: "Sales Receipt (cash sale)", prefix: "SR-", padding: 6, next: 1 },
  { key: "receipt", label: "Customer Receipt", prefix: "RCT-", padding: 6, next: 1 },
  { key: "refund-receipt", label: "Refund Receipt", prefix: "REF-", padding: 6, next: 1 },
  { key: "credit-note", label: "Credit Note", prefix: "CN-", padding: 6, next: 1 },
  { key: "requisition", label: "Purchase Requisition", prefix: "PR-", padding: 6, next: 1 },
  { key: "po", label: "Purchase Order", prefix: "PO-", padding: 6, next: 1 },
  { key: "goods-receipt", label: "Goods Receipt Note", prefix: "GRN-", padding: 6, next: 1 },
  { key: "bill", label: "Vendor Bill", prefix: "BILL-", padding: 6, next: 1 },
  { key: "payment", label: "Vendor Payment", prefix: "PMT-", padding: 6, next: 1 },
  { key: "vendor-credit", label: "Vendor Credit", prefix: "VC-", padding: 6, next: 1 },
  { key: "expense", label: "Expense Claim", prefix: "EXP-", padding: 6, next: 1 },
];

export const STARTER_PAYMENT_TERMS = [
  { id: "pt-receipt", name: "Due on receipt", netDays: 0, eom: false, active: true },
  { id: "pt-net15", name: "Net 15", netDays: 15, eom: false, active: true },
  { id: "pt-net30", name: "Net 30", netDays: 30, eom: false, active: true },
  { id: "pt-net45", name: "Net 45", netDays: 45, eom: false, active: true },
  { id: "pt-net60", name: "Net 60", netDays: 60, eom: false, active: true },
  { id: "pt-2-10-30", name: "2/10 Net 30", netDays: 30, eom: false, discountPercent: 2, discountDays: 10, active: true },
  { id: "pt-eom", name: "Net 30 EOM", netDays: 30, eom: true, active: true },
];

export const STARTER_REMINDER_RULES = [
  { id: "rr-1", level: 1, daysOverdue: 3, tone: "Friendly", subject: "Gentle reminder — invoice {number}", body: "We noticed invoice {number} for {amount} became due on {dueDate}. If payment is already on its way, thank you. Otherwise a prompt settlement would be appreciated.", active: true },
  { id: "rr-2", level: 2, daysOverdue: 14, tone: "Firm", subject: "Overdue — invoice {number} ({daysOverdue} days)", body: "Invoice {number} for {amount} is now {daysOverdue} days overdue. Please arrange payment within 5 working days to keep the account in good standing.", active: true },
  { id: "rr-3", level: 3, daysOverdue: 30, tone: "Final Notice", subject: "FINAL NOTICE — invoice {number}", body: "Invoice {number} for {amount} is {daysOverdue} days overdue. Unless settled within 7 days the account will be placed on credit hold and referred for collection.", active: true },
];

export const STARTER_TAX_RATES = [
  { id: "tax-vat-standard", name: "VAT 7.5%", kind: "VAT", rate: 7.5, accountNumber: 2200, isCompound: false, isActive: true, description: "Standard Nigerian VAT" },
  { id: "tax-vat-exempt", name: "VAT Exempt", kind: "Exempt", rate: 0, accountNumber: 2200, isCompound: false, isActive: true, description: "Medical services exempt from VAT" },
  { id: "tax-vat-zero", name: "Zero-rated", kind: "Zero-rated", rate: 0, accountNumber: 2200, isCompound: false, isActive: true },
  { id: "tax-wht-5", name: "WHT 5%", kind: "WHT", rate: 5, accountNumber: 2210, isCompound: false, isActive: true, description: "Withholding tax — goods/rent" },
  { id: "tax-wht-10", name: "WHT 10%", kind: "WHT", rate: 10, accountNumber: 2210, isCompound: false, isActive: true, description: "Withholding tax — professional services" },
  { id: "tax-levy-1", name: "NHIS Levy 1%", kind: "VAT", rate: 1, accountNumber: 2220, isCompound: false, isActive: true, description: "Statutory health levy on non-exempt services — stacks on top of VAT" },
];

export const STARTER_ORG_PROFILE = { legalName: '', tradingName: '', tin: '', rcNumber: '', address: '', reportingCurrency: 'NGN', fiscalYearStartMonth: 1 };
export const STARTER_TAX_REGISTRATION = { vatTin: '', wht: false, payeStateId: '', vatRegistered: false };
