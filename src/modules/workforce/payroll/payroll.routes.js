// /api/v1/workforce/organizations/:organizationId/payroll (salary structures, payslips, contracts,
// staff loans, reimbursements). Mounted under the Workforce tenant router.
//
// Who can do what (migration 20261115090000_workforce_payroll):
//   HR officer, finance officer, owner:   read (payroll.read) and change (payroll.manage)
//   everyone else:                        nothing here — salary data is its own permission
// Records only: marking a payslip or claim paid records a payment made outside Sabi.
import express from 'express';
import { z } from 'zod';
import { requireEmrPermission as allow } from '../../emr/core/context.js';
import { handle, validateEmr as check } from '../../emr/core/validate.js';
import { send } from '../../emr/core/http.js';
import * as payroll from './payroll.service.js';

const org = { organizationId: z.uuid() };
const withId = { ...org, id: z.uuid() };
const noQuery = z.object({}).strict();
const text = (max) => z.string().trim().min(1).max(max).regex(/^(?:[^\p{Cc}]|[\n\r\t])+$/u, 'Contains control characters');
const date = z.iso.date();
const amount = z.number().min(0).max(1e12);
const positive = z.number().positive().max(1e12);
const body = (shape, params = org) => z.object({ params: z.object(params).strict(), query: noQuery, body: z.object(shape).strict() });
const component = z.object({ name: text(80), amount }).strict();
const clientId = { id: z.uuid().optional() };

const v = {
  overview: z.object({ params: z.object(org).strict(), query: noQuery }),
  structure: body({ basicSalary: amount, allowances: z.array(component).max(20), deductions: z.array(component).max(20) }, { ...org, employeeId: z.uuid() }),
  batch: body({ batch: text(80), startDate: date, endDate: date, employeeIds: z.array(z.uuid()).min(1).max(1000) }),
  empty: body({}, withId),
  confirmBatch: body({ batch: text(80) }),
  contract: body({ ...clientId, employeeId: z.uuid(), title: text(160), startDate: date, endDate: date.optional(), basicSalary: amount }),
  loan: body({ ...clientId, employeeId: z.uuid(), type: text(60), amount: positive, installments: z.number().int().min(1).max(120), reason: text(1000), repaymentMethod: z.enum(['Manual', 'Salary Auto-Debit']) }),
  decideLoan: body({ status: z.enum(['Approved', 'Rejected']) }, withId),
  payment: body({ amount: positive, date }, withId),
  tier: body({ ...clientId, minMonthlySalary: amount, maxMonthlySalary: amount.nullable(), maxLoanAmount: positive }),
  reimbursement: body({ ...clientId, employeeId: z.uuid(), type: z.enum(['Expense Claim', 'Leave Encashment']), title: text(200), amount: positive }),
  decideReimbursement: body({ status: z.enum(['Approved', 'Rejected', 'Paid']) }, withId),
};

const READ = ['payroll.read'];
const MANAGE = ['payroll.manage'];
export const payrollRoutes = express.Router({ mergeParams: true });
const r = (method, path, schema, perms, fn, status = 200) => payrollRoutes[method](path, check(schema), allow(...perms), handle(async (req, res) => send(res, await fn(req), status)));

r('get', '/', v.overview, READ, (req) => payroll.overview(req.emr));
r('put', '/structures/:employeeId', v.structure, MANAGE, (req) => payroll.setStructure(req.emr, req.params.employeeId, req.body));
r('post', '/batches', v.batch, MANAGE, (req) => payroll.runBatch(req.emr, req.body), 201);
r('post', '/batches/confirm', v.confirmBatch, MANAGE, (req) => payroll.confirmBatch(req.emr, req.body.batch));
r('post', '/payslips/:id/advance', v.empty, MANAGE, (req) => payroll.advancePayslip(req.emr, req.params.id));
r('post', '/contracts', v.contract, MANAGE, (req) => payroll.addContract(req.emr, req.body), 201);
r('post', '/loans', v.loan, MANAGE, (req) => payroll.requestLoan(req.emr, req.body), 201);
r('post', '/loans/:id/decide', v.decideLoan, MANAGE, (req) => payroll.decideLoan(req.emr, req.params.id, req.body));
r('post', '/loans/:id/payments', v.payment, MANAGE, (req) => payroll.recordPayment(req.emr, req.params.id, req.body), 201);
r('post', '/loans/:id/check-overdue', v.empty, MANAGE, (req) => payroll.checkOverdue(req.emr, req.params.id));
r('post', '/letters/:id/sent', v.empty, MANAGE, (req) => payroll.markLetterSent(req.emr, req.params.id));
r('post', '/loan-tiers', v.tier, MANAGE, (req) => payroll.addTier(req.emr, req.body), 201);
r('post', '/reimbursements', v.reimbursement, MANAGE, (req) => payroll.requestReimbursement(req.emr, req.body), 201);
r('post', '/reimbursements/:id/decide', v.decideReimbursement, MANAGE, (req) => payroll.decideReimbursement(req.emr, req.params.id, req.body));
