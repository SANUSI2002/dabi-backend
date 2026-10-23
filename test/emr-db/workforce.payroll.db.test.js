// Payroll records against real Postgres with RLS on: salary structures, payslips computed by the server
// (with a salary-auto-debit loan instalment) and confirmed by someone other than whoever generated them,
// loans within the eligibility tier, decided by someone else, repaid and flagged overdue with a letter,
// and reimbursements. Salary data is hidden from everyone without payroll access.
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { app } from '../../src/app.js';
import { addMember, createTenant, prisma } from './fixtures.js';

const as = (who) => {
  const url = (path) => `/api/v1/workforce/organizations/${who.organizationId}${path}`;
  return {
    get: (path) => request(app).get(url(path)).set('Authorization', who.auth),
    post: (path, body = {}) => request(app).post(url(path)).set('Authorization', who.auth).send(body),
    put: (path, body = {}) => request(app).put(url(path)).set('Authorization', who.auth).send(body),
  };
};
const ok = (res, status = 200) => { expect(res.status, JSON.stringify(res.body)).toBe(status); return res.body.data; };

let A; let hr; let finance; let nurse; let admin; let ids;
const member = async (tenant, roles) => ({ ...(await addMember(tenant, roles)), organizationId: tenant.organizationId });
const payroll = async (who = hr) => (await as(who).get('/payroll')).body.data;

beforeAll(async () => {
  A = await createTenant('wpA', { modules: ['workforce'] });
  hr = await member(A, ['HR_OFFICER']);
  finance = await member(A, ['FINANCE_OFFICER']);
  nurse = await member(A, ['NURSE']);
  admin = await member(A, ['HOSPITAL_ADMIN']);
  await as(hr).post('/people/employees/import-members');
  const emps = (await as(hr).get('/people')).body.data.employees;
  const idOf = (who) => emps.find((e) => e.userId === who.userId).id;
  ids = { hr: idOf(hr), finance: idOf(finance), nurse: idOf(nurse), admin: idOf(admin) };
});

describe('payroll records', () => {
  it('keeps salary data to payroll staff', async () => {
    expect((await as(nurse).get('/payroll')).status).toBe(403);
    expect((await as(admin).get('/payroll')).status).toBe(403); // HR access is not salary access
    expect((await as(finance).get('/payroll')).status).toBe(200);
  });

  it('caps loans by salary tier and never lets someone decide their own', async () => {
    ok(await as(hr).put(`/payroll/structures/${ids.nurse}`, { basicSalary: 180000, allowances: [{ name: 'Housing', amount: 40000 }], deductions: [{ name: 'Pension', amount: 14400 }] }));
    ok(await as(hr).put(`/payroll/structures/${ids.hr}`, { basicSalary: 300000, allowances: [], deductions: [] }));
    ok(await as(hr).post('/payroll/loan-tiers', { minMonthlySalary: 0, maxMonthlySalary: 200000, maxLoanAmount: 300000 }), 201);
    expect((await as(hr).post('/payroll/loan-tiers', { minMonthlySalary: 150000, maxMonthlySalary: null, maxLoanAmount: 900000 })).status).toBe(400); // overlaps
    expect((await as(hr).post('/payroll/loans', { employeeId: ids.nurse, type: 'Salary Advance', amount: 400000, installments: 4, reason: 'Rent', repaymentMethod: 'Manual' })).status).toBe(400);
    const loan = ok(await as(hr).post('/payroll/loans', { employeeId: ids.nurse, type: 'Salary Advance', amount: 90000, installments: 3, reason: 'School fees', repaymentMethod: 'Salary Auto-Debit' }), 201);
    expect((await as(hr).post(`/payroll/loans/${loan.id}/decide`, { status: 'Approved' })).body.error.code).toBe('OWN_REQUEST'); // HR raised it
    ok(await as(finance).post(`/payroll/loans/${loan.id}/decide`, { status: 'Approved' }));
    const own = ok(await as(hr).post('/payroll/loans', { employeeId: ids.finance, type: 'Salary Advance', amount: 50000, installments: 1, reason: 'x', repaymentMethod: 'Manual' }), 201);
    expect((await as(finance).post(`/payroll/loans/${own.id}/decide`, { status: 'Approved' })).body.error.code).toBe('OWN_REQUEST'); // their own loan
  });

  it('computes payslips on the server, confirms by a second person, and takes the loan instalment when paid', async () => {
    expect((await as(hr).post('/payroll/batches', { batch: 'Nov 2026', startDate: '2026-11-01', endDate: '2026-11-30', employeeIds: [ids.nurse, ids.admin] })).body.error.message).toMatch(/Set a salary for/);
    ok(await as(hr).post('/payroll/batches', { batch: 'Nov 2026', startDate: '2026-11-01', endDate: '2026-11-30', employeeIds: [ids.nurse, ids.hr] }), 201);
    expect((await as(hr).post('/payroll/batches', { batch: 'Nov 2026', startDate: '2026-11-01', endDate: '2026-11-30', employeeIds: [ids.nurse] })).body.error.code).toBe('PAYSLIP_EXISTS');
    let data = await payroll();
    const slip = data.payslips.find((p) => p.employeeId === ids.nurse);
    expect(slip).toMatchObject({ status: 'Draft', grossPay: 220000, totalDeductions: 44400, netPay: 175600, generatedByMe: true });
    expect(slip.deductions.map((d) => d.name)).toEqual(['Pension', 'Loan repayment (auto-debit)']);
    for (const p of data.payslips) ok(await as(hr).post(`/payroll/payslips/${p.id}/advance`)); // → review
    expect((await as(hr).post('/payroll/batches/confirm', { batch: 'Nov 2026' })).body.error.code).toBe('MAKER_CHECKER');
    expect(ok(await as(finance).post('/payroll/batches/confirm', { batch: 'Nov 2026' }))).toMatchObject({ confirmed: 2 });
    ok(await as(finance).post(`/payroll/payslips/${slip.id}/advance`)); // → paid (recorded)
    expect((await as(finance).post(`/payroll/payslips/${slip.id}/advance`)).status).toBe(409);
    data = await payroll();
    expect(data.payslips.find((p) => p.id === slip.id)).toMatchObject({ status: 'Paid', paidAt: expect.any(String) });
    const loan = data.loans.find((l) => l.employeeId === ids.nurse);
    expect(loan).toMatchObject({ status: 'Repaying', installmentsPaid: 1, totalPaid: 30000 });
    expect(data.loanPayments.filter((p) => p.loanId === loan.id)).toEqual([expect.objectContaining({ amount: 30000, date: '2026-11-30' })]);
  });

  it('flags a manual loan overdue after its window, with a letter when it is large', async () => {
    ok(await as(hr).put(`/payroll/structures/${ids.admin}`, { basicSalary: 20000, allowances: [], deductions: [] }));
    const loan = ok(await as(hr).post('/payroll/loans', { employeeId: ids.admin, type: 'Emergency Loan', amount: 300000, installments: 6, reason: 'Medical bills', repaymentMethod: 'Manual' }), 201);
    ok(await as(finance).post(`/payroll/loans/${loan.id}/decide`, { status: 'Approved' }));
    expect(ok(await as(hr).post(`/payroll/loans/${loan.id}/check-overdue`))).toMatchObject({ overdue: false });
    await prisma.wfLoan.update({ where: { id: loan.id }, data: { periodStartDate: new Date(Date.now() - 35 * 86_400_000) } }); // a month passes unpaid
    const flagged = ok(await as(hr).post(`/payroll/loans/${loan.id}/check-overdue`));
    expect(flagged).toMatchObject({ overdue: true, letterId: expect.any(String) });
    ok(await as(hr).post(`/payroll/letters/${flagged.letterId}/sent`));
    expect((await as(hr).post(`/payroll/letters/${flagged.letterId}/sent`)).status).toBe(409);
    const data = await payroll();
    expect(data.loans.find((l) => l.id === loan.id)).toMatchObject({ status: 'Overdue', missedPeriods: 1, currentPeriodDue: 100000 });
    expect(data.escalationLetters[0]).toMatchObject({ loanId: loan.id, level: 1, amountOwed: 50000, sent: true });
    ok(await as(hr).post(`/payroll/loans/${loan.id}/payments`, { amount: 100000, date: '2026-11-20' }), 201);
    expect((await payroll()).loans.find((l) => l.id === loan.id)).toMatchObject({ status: 'Repaying', installmentsPaid: 1, totalPaid: 100000 });
  });

  it('approves and records reimbursements', async () => {
    const r = ok(await as(hr).post('/payroll/reimbursements', { employeeId: ids.nurse, type: 'Expense Claim', title: 'Outreach transport', amount: 7500 }), 201);
    expect((await as(finance).post(`/payroll/reimbursements/${r.id}/decide`, { status: 'Paid' })).status).toBe(409); // approve first
    ok(await as(finance).post(`/payroll/reimbursements/${r.id}/decide`, { status: 'Approved' }));
    ok(await as(finance).post(`/payroll/reimbursements/${r.id}/decide`, { status: 'Paid' }));
    expect((await payroll()).reimbursements[0]).toMatchObject({ status: 'Paid', amount: 7500 });
  });
});
