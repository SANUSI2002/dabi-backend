// Starter platform configuration: the master-data lists and letter templates each organization begins
// with (the same ones the Settings screens ship), seeded once per organization and then edited there.
export const MASTER_CATEGORIES = [
  { key: "leave-types", label: "Leave Types", product: "workforce", description: "Categories of leave employees can request" },
  { key: "employment-types", label: "Employment Types", product: "workforce", description: "Full-time, contract, locum, etc." },
  { key: "document-types", label: "Employee Document Types", product: "workforce", description: "Categories for the employee document library", fields: [{ key: "expires", label: "Has expiry", type: "checkbox" }, { key: "mandatory", label: "Required at onboarding", type: "checkbox" }] },
  { key: "certification-types", label: "Certification / Licence Types", product: "workforce", description: "Professional bodies and licence classes", fields: [{ key: "renewalMonths", label: "Renewal cycle (months)", type: "number" }] },
  { key: "query-types", label: "Disciplinary Query Types", product: "workforce", description: "Reasons a query can be raised" },
  { key: "recruitment-statuses", label: "Recruitment Statuses", product: "workforce", description: "Stages an applicant moves through", fields: [{ key: "terminal", label: "Ends the pipeline", type: "checkbox" }] },
  { key: "vacancy-types", label: "Vacancy Types", product: "workforce", description: "New role, replacement, temporary cover, etc." },
  { key: "handover-item-types", label: "Handover Item Types", product: "workforce", description: "What a role handover checklist can contain" },
  { key: "loan-types", label: "Loan Types", product: "workforce", description: "Named loan products with default terms", fields: [{ key: "maxMonths", label: "Max term (months)", type: "number" }, { key: "autoDebit", label: "Salary auto-debit", type: "checkbox" }] },
  { key: "id-types", label: "Identification Types", product: "platform", description: "NIN, passport, driver's licence, voter card" },
  { key: "ward-types", label: "Ward Types", product: "emr", description: "General, maternity, paediatric, ICU, isolation" },
  { key: "bed-types", label: "Bed Types", product: "emr", description: "Standard, VIP, cot, incubator, recovery" },
  { key: "lab-sample-types", label: "Lab Sample Types", product: "emr", description: "Blood, urine, stool, swab, CSF, tissue" },
  { key: "lab-stage-types", label: "Lab Stage Types", product: "emr", description: "Named processing stages tests can be composed from" },
  { key: "drug-categories", label: "Drug Categories", product: "emr", description: "Therapeutic groups the formulary is filed under and prescribers search by — managed by the pharmacy", editors: ["emr.formulary.manage", "catalog.manage"], fields: [{ key: "emdexClasses", label: "EMDEX class names (comma-separated)", type: "text" }] },
  { key: "drug-classes", label: "Drug Classes", product: "emr", description: "Pharmacological classes behind the allergy and duplicate-therapy checks — managed by the pharmacy", editors: ["emr.formulary.manage", "catalog.manage"] },
  { key: "expense-categories", label: "Expense Categories", product: "accounting", description: "Categories for staff expense claims" },
];

export const MASTER_SEED = {
  "drug-categories": [
    { label: "Analgesics & Antipyretics", code: "ANALGESIC", active: true },
    { label: "Opioid Analgesics", code: "OPIOID", active: true },
    { label: "Antibiotics", code: "ANTIBIOTIC", active: true },
    { label: "Antimalarials", code: "ANTIMALARIAL", active: true },
    { label: "Antiprotozoals", code: "ANTIPROTOZOAL", active: true },
    { label: "Antifungals", code: "ANTIFUNGAL", active: true },
    { label: "Antivirals & Antiretrovirals", code: "ANTIVIRAL", active: true },
    { label: "Anthelmintics", code: "ANTHELMINTIC", active: true },
    { label: "Antihypertensives", code: "ANTIHYPERTENSIVE", active: true },
    { label: "Other Cardiovascular", code: "CARDIOVASCULAR", active: true },
    { label: "Antidiabetics", code: "ANTIDIABETIC", active: true },
    { label: "Anticoagulants & Antiplatelets", code: "ANTICOAGULANT", active: true },
    { label: "Respiratory (bronchodilators, cough)", code: "RESPIRATORY", active: true },
    { label: "Antihistamines & Anti-allergy", code: "ANTIHISTAMINE", active: true },
    { label: "Gastrointestinal (antacids, PPIs, antiemetics)", code: "GASTROINTESTINAL", active: true },
    { label: "Corticosteroids", code: "CORTICOSTEROID", active: true },
    { label: "Hormones & Contraceptives", code: "HORMONE", active: true },
    { label: "Psychotropics", code: "PSYCHOTROPIC", active: true },
    { label: "Anticonvulsants", code: "ANTICONVULSANT", active: true },
    { label: "IV Fluids & Electrolytes", code: "FLUIDS", active: true },
    { label: "Vitamins & Supplements", code: "VITAMIN", active: true },
    { label: "Haematinics", code: "HAEMATINIC", active: true },
    { label: "Vaccines & Sera", code: "VACCINE", active: true },
    { label: "Dermatological (topical)", code: "DERMATOLOGICAL", active: true },
    { label: "Eye, Ear & Nose", code: "EYE_EAR_NOSE", active: true },
    { label: "Anaesthetics", code: "ANAESTHETIC", active: true },
    { label: "Other", code: "OTHER", active: true, system: true },
  ],
  "drug-classes": [
    { label: "Simple analgesic", code: "ANALGESIC", active: true, system: true },
    { label: "NSAID", code: "NSAID", active: true, system: true },
    { label: "Opioid", code: "OPIOID", active: true, system: true },
    { label: "Penicillin", code: "PENICILLIN", active: true, system: true },
    { label: "Beta-lactam", code: "BETA_LACTAM", active: true, system: true },
    { label: "Cephalosporin", code: "CEPHALOSPORIN", active: true, system: true },
    { label: "Carbapenem", code: "CARBAPENEM", active: true },
    { label: "Macrolide", code: "MACROLIDE", active: true },
    { label: "Tetracycline", code: "TETRACYCLINE", active: true },
    { label: "Aminoglycoside", code: "AMINOGLYCOSIDE", active: true },
    { label: "Fluoroquinolone", code: "FLUOROQUINOLONE", active: true, system: true },
    { label: "Sulfonamide", code: "SULFONAMIDE", active: true },
    { label: "Nitroimidazole", code: "NITROIMIDAZOLE", active: true, system: true },
    { label: "Antimalarial", code: "ANTIMALARIAL", active: true, system: true },
    { label: "Biguanide", code: "BIGUANIDE", active: true, system: true },
    { label: "Sulfonylurea", code: "SULFONYLUREA", active: true },
    { label: "Insulin", code: "INSULIN", active: true, system: true },
    { label: "ACE inhibitor", code: "ACE_INHIBITOR", active: true },
    { label: "Angiotensin receptor blocker", code: "ARB", active: true },
    { label: "Calcium channel blocker", code: "CALCIUM_CHANNEL_BLOCKER", active: true, system: true },
    { label: "Beta blocker", code: "BETA_BLOCKER", active: true },
    { label: "Thiazide diuretic", code: "THIAZIDE", active: true },
    { label: "Loop diuretic", code: "LOOP_DIURETIC", active: true },
    { label: "Statin", code: "STATIN", active: true },
    { label: "Anticoagulant", code: "ANTICOAGULANT", active: true },
    { label: "Proton pump inhibitor", code: "PPI", active: true, system: true },
    { label: "H2 receptor blocker", code: "H2_BLOCKER", active: true },
    { label: "Corticosteroid", code: "CORTICOSTEROID", active: true, system: true },
    { label: "Beta-2 agonist", code: "BETA_AGONIST", active: true, system: true },
    { label: "Antihistamine", code: "ANTIHISTAMINE", active: true },
    { label: "Benzodiazepine", code: "BENZODIAZEPINE", active: true },
    { label: "Iron preparation", code: "IRON", active: true, system: true },
  ],
  "leave-types": [
    { label: "Annual Leave", code: "ANNUAL", active: true, system: true, meta: { paid: true } },
    { label: "Sick Leave", code: "SICK", active: true, system: true, meta: { paid: true } },
    { label: "Maternity Leave", code: "MAT", active: true, system: true, meta: { paid: true } },
    { label: "Paternity Leave", code: "PAT", active: true },
    { label: "Compassionate Leave", code: "COMP", active: true },
    { label: "Study Leave", code: "STUDY", active: true },
    { label: "Leave of Absence (unpaid)", code: "LOA", active: true, meta: { paid: false } },
  ],
  "employment-types": [
    { label: "Full-time (permanent)", code: "FT", active: true, system: true },
    { label: "Contract (fixed-term)", code: "CT", active: true, system: true },
    { label: "Locum", code: "LOC", active: true },
    { label: "Part-time", code: "PT", active: true },
    { label: "NYSC / Internship", code: "INT", active: true },
  ],
  "document-types": [
    { label: "National ID (NIN)", code: "NIN", active: true, system: true, meta: { mandatory: true, expires: false } },
    { label: "Curriculum Vitae", code: "CV", active: true, system: true, meta: { mandatory: true } },
    { label: "Signed Offer Letter", code: "OFFER", active: true, meta: { mandatory: true } },
    { label: "Degree Certificate", code: "DEGREE", active: true },
    { label: "Professional Practising Licence", code: "LICENCE", active: true, meta: { expires: true } },
    { label: "NYSC Discharge Certificate", code: "NYSC", active: true },
    { label: "Reference Letter", code: "REF", active: true },
    { label: "Guarantor Form", code: "GUAR", active: true },
    { label: "Medical Fitness Certificate", code: "MEDFIT", active: true, meta: { expires: true } },
  ],
  "certification-types": [
    { label: "MDCN Annual Practising Licence", code: "MDCN", active: true, meta: { renewalMonths: 12 } },
    { label: "Nursing & Midwifery Council Licence", code: "NMCN", active: true, meta: { renewalMonths: 36 } },
    { label: "MLSCN Licence (Lab Scientist)", code: "MLSCN", active: true, meta: { renewalMonths: 12 } },
    { label: "PCN Licence (Pharmacist)", code: "PCN", active: true, meta: { renewalMonths: 12 } },
    { label: "Radiographers Registration Board Licence", code: "RRBN", active: true, meta: { renewalMonths: 12 } },
    { label: "BLS / ACLS Certification", code: "BLS", active: true, meta: { renewalMonths: 24 } },
  ],
  "query-types": [
    { label: "Absence without leave", code: "AWOL", active: true },
    { label: "Lateness / punctuality", code: "LATE", active: true },
    { label: "Insubordination", code: "INSUB", active: true },
    { label: "Negligence of duty", code: "NEGL", active: true },
    { label: "Breach of policy", code: "POLICY", active: true },
    { label: "Misconduct", code: "MISCON", active: true },
  ],
  "recruitment-statuses": [
    { label: "Applied", code: "APPLIED", active: true, system: true },
    { label: "Screening", code: "SCREEN", active: true },
    { label: "Shortlisted", code: "SHORT", active: true },
    { label: "Interview", code: "INTERVIEW", active: true },
    { label: "Assessment", code: "ASSESS", active: true },
    { label: "Reference Check", code: "REFCHK", active: true },
    { label: "Offer", code: "OFFER", active: true },
    { label: "Hired", code: "HIRED", active: true, system: true, meta: { terminal: true } },
    { label: "Rejected", code: "REJECTED", active: true, system: true, meta: { terminal: true } },
    { label: "Withdrawn", code: "WITHDRAWN", active: true, meta: { terminal: true } },
  ],
  "vacancy-types": [
    { label: "New position", code: "NEW", active: true },
    { label: "Replacement (exit)", code: "REPL", active: true },
    { label: "Temporary cover", code: "TEMP", active: true },
    { label: "Additional headcount", code: "ADD", active: true },
  ],
  "handover-item-types": [
    { label: "Outstanding task", code: "TASK", active: true, system: true },
    { label: "Active project", code: "PROJECT", active: true, system: true },
    { label: "Pending approval", code: "APPROVAL", active: true },
    { label: "Key document", code: "DOC", active: true },
    { label: "Allocated asset", code: "ASSET", active: true },
    { label: "Direct report", code: "REPORT", active: true },
    { label: "External contact / relationship", code: "CONTACT", active: true },
    { label: "Open issue", code: "ISSUE", active: true },
  ],
  "loan-types": [
    { label: "Staff Advance", code: "ADV", active: true, meta: { maxMonths: 3, autoDebit: true } },
    { label: "Personal Loan", code: "PERS", active: true, meta: { maxMonths: 12, autoDebit: true } },
    { label: "Asset Loan (vehicle / device)", code: "ASSET", active: true, meta: { maxMonths: 24 } },
    { label: "Emergency Medical Loan", code: "MED", active: true, meta: { maxMonths: 6 } },
  ],
  "id-types": [
    { label: "National Identification Number (NIN)", code: "NIN", active: true, system: true },
    { label: "International Passport", code: "PASSPORT", active: true },
    { label: "Driver's Licence", code: "DL", active: true },
    { label: "Permanent Voter's Card", code: "PVC", active: true },
  ],
  "ward-types": [
    { label: "General Ward", code: "GEN", active: true, system: true },
    { label: "Maternity Ward", code: "MAT", active: true },
    { label: "Paediatric Ward", code: "PAED", active: true },
    { label: "Private / Amenity", code: "PRIV", active: true },
    { label: "Isolation Ward", code: "ISO", active: true },
    { label: "Intensive Care Unit", code: "ICU", active: true },
  ],
  "bed-types": [
    { label: "Standard Bed", code: "STD", active: true, system: true },
    { label: "VIP Bed", code: "VIP", active: true },
    { label: "Cot", code: "COT", active: true },
    { label: "Incubator", code: "INCU", active: true },
    { label: "Recovery Bed", code: "REC", active: true },
  ],
  "lab-sample-types": [
    { label: "Whole Blood", code: "WB", active: true, system: true },
    { label: "Serum", code: "SER", active: true },
    { label: "Plasma", code: "PLA", active: true },
    { label: "Urine", code: "URN", active: true },
    { label: "Stool", code: "STL", active: true },
    { label: "Swab", code: "SWB", active: true },
    { label: "CSF", code: "CSF", active: true },
    { label: "Tissue / Biopsy", code: "TIS", active: true },
  ],
  "lab-stage-types": [
    { label: "Sample Collection", code: "COLLECT", active: true, system: true },
    { label: "Registration / Accessioning", code: "ACCESSION", active: true },
    { label: "Centrifugation / Preparation", code: "PREP", active: true },
    { label: "Screening / Dipstick", code: "SCREEN", active: true },
    { label: "Primary Analysis", code: "PRIMARY", active: true },
    { label: "Secondary / Confirmatory Analysis", code: "SECONDARY", active: true },
    { label: "Microscopy", code: "MICRO", active: true },
    { label: "Culture & Sensitivity", code: "CULTURE", active: true },
    { label: "Final Review", code: "REVIEW", active: true },
    { label: "Chief Scientist Approval", code: "APPROVAL", active: true, system: true },
  ],
  "expense-categories": [
    { label: "Travel & Transport", code: "TRAVEL", active: true },
    { label: "Training & Conferences", code: "TRAIN", active: true },
    { label: "Meals & Entertainment", code: "MEALS", active: true },
    { label: "Office Supplies", code: "SUPPLIES", active: true },
    { label: "Medical Consumables (petty)", code: "CONSUM", active: true },
  ],
};

export const LETTER_TEMPLATES = [
  {
    key: "offer",
    name: "Offer of Employment",
    category: "Onboarding",
    system: true,
    signatories: ["For and on behalf of {{organisation}}", "Accepted by {{candidate_name}}"],
    body: `Dear {{candidate_name}},

Following your application and interview, we are pleased to offer you the position of {{position}} in the {{department}} department at {{organisation}}, reporting to {{reporting_to}}.

Your basic salary will be {{basic_salary}} per month, subject to statutory deductions. Your employment type is {{employment_type}} and your expected date of resumption is {{resumption_date}}.

This offer is conditional on satisfactory reference checks and the submission of all required documents. Please indicate your acceptance by signing and returning a copy of this letter on or before {{offer_deadline}}.

We look forward to welcoming you to the team.`,
  },
  {
    key: "missing-document",
    name: "Outstanding Document Notice",
    category: "Onboarding",
    system: true,
    signatories: ["{{issued_by}} — {{issuer_role}}", "Employee acknowledgement"],
    body: `Dear {{employee_name}},

Our records show that the following document(s) required for your employment file remain outstanding:

{{document_list}}

You are required to submit the item(s) above to the {{department}} / HR office on or before {{deadline}}. Failure to comply by this date may affect your confirmation and, where applicable, access to certain duties.

If any document is genuinely unavailable, please provide a written explanation and an expected date of submission.`,
  },
  {
    key: "query",
    name: "Query Letter",
    category: "Discipline",
    system: true,
    signatories: ["{{issued_by}} — Line Manager", "HR", "Employee acknowledgement"],
    body: `Dear {{employee_name}},

RE: {{subject}}

It has been brought to management's attention that {{incident}}.

You are required to provide a written explanation of the above within {{response_days}} working days of receipt of this letter. Your response should be addressed to the Human Resources office.

Please note that this is a formal query and your explanation will be considered before any further action is taken.`,
  },
  {
    key: "promotion",
    name: "Letter of Promotion",
    category: "Movement",
    system: true,
    signatories: ["{{issued_by}} — Human Resources", "Employee acknowledgement"],
    body: `Dear {{employee_name}},

We are pleased to inform you that, following review and the necessary approvals, you have been promoted from {{from_position}} to {{to_position}} with effect from {{effective_date}}.

Your revised basic salary will be {{new_salary}} per month. You will now report to {{new_reporting_to}}.

Congratulations on this well-deserved advancement. We trust you will continue to discharge your duties with the same commitment.`,
  },
  {
    key: "transfer",
    name: "Letter of Transfer",
    category: "Movement",
    system: true,
    signatories: ["{{issued_by}} — Human Resources", "Employee acknowledgement"],
    body: `Dear {{employee_name}},

This is to inform you that you have been transferred from {{from_branch}} to {{to_branch}} with effect from {{effective_date}}.

Your position ({{position}}) and terms of employment remain unchanged. You are expected to complete the handover of your current responsibilities before the effective date and to report to the receiving location on {{effective_date}}.`,
  },
  {
    key: "loan-escalation",
    name: "Loan Repayment Escalation",
    category: "Finance",
    system: true,
    signatories: ["{{issued_by}} — Payroll / Finance"],
    body: `Dear {{employee_name}},

RE: Overdue loan repayment — {{loan_reference}}

Our records indicate that your scheduled repayment of {{period_amount}} for the period ending {{period_end}} has not been received in full. The outstanding shortfall of {{shortfall}} will be added to your next scheduled repayment, making the next amount due {{next_due}}.

Please regularise this at the earliest opportunity. Continued default may result in the full outstanding balance being recovered from your salary or terminal benefits.`,
  },
  {
    key: "warning",
    name: "Warning Letter",
    category: "Discipline",
    signatories: ["{{issued_by}} — Human Resources", "Employee acknowledgement"],
    body: `Dear {{employee_name}},

RE: {{subject}}

Further to the query issued to you and your response thereto, management has decided to issue you this {{warning_level}} warning in respect of {{incident}}.

You are advised that any repetition of this or similar conduct will attract more severe disciplinary action, up to and including termination of your employment.

This letter will be placed in your personnel file.`,
  },
];
