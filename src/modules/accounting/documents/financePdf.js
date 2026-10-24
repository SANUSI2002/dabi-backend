// Printable finance documents: invoices, statements of account and remittance advice, as PDF.
//
// The renderers take plain data already read (and checked) by the services and return the PDF bytes;
// they never touch the database. Text uses the standard Helvetica fonts, so anything those fonts cannot
// encode is replaced (amounts say "NGN", not the naira sign). Long tables continue on new pages with
// their header repeated, and every page carries "Page x of y".
import { Buffer } from 'node:buffer';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const A4 = [595.28, 841.89];
const M = 48; // page margin
const INK = rgb(0.12, 0.14, 0.17);
const MUTED = rgb(0.42, 0.45, 0.5);
const RULE = rgb(0.82, 0.84, 0.87);
const BAND = rgb(0.95, 0.96, 0.97);

export const pdfMoney = (amount, currency = 'NGN') => `${currency} ${Number(amount ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plain = (amount) => Number(amount ?? 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (d) => {
  if (!d) return '';
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

class Sheet {
  static async create(title) {
    const doc = await PDFDocument.create();
    doc.setTitle(title); doc.setProducer('Sabi Health'); doc.setCreator('Sabi Health accounting');
    const s = new Sheet(doc, await doc.embedFont(StandardFonts.Helvetica), await doc.embedFont(StandardFonts.HelveticaBold));
    s.newPage();
    return s;
  }
  constructor(doc, regular, bold) {
    this.doc = doc; this.regular = regular; this.bold = bold;
    this.charset = new Set(regular.getCharacterSet());
  }
  newPage() { this.page = this.doc.addPage(A4); this.y = A4[1] - M; }
  /** Text the font can draw: typographic quotes kept where possible, everything else replaced. */
  safe(text) {
    return String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/₦\s?/g, 'NGN ').split('').map((c) => (this.charset.has(c.codePointAt(0)) ? c : '?')).join('');
  }
  width(text, size, font = this.regular) { return font.widthOfTextAtSize(this.safe(text), size); }
  /** Cuts text to fit a width, ending in "..." when cut. */
  fit(text, size, max, font = this.regular) {
    let t = this.safe(text);
    if (font.widthOfTextAtSize(t, size) <= max) return t;
    while (t.length && font.widthOfTextAtSize(`${t}...`, size) > max) t = t.slice(0, -1);
    return `${t}...`;
  }
  /** Splits text into lines no wider than max. */
  wrap(text, size, max, font = this.regular) {
    const out = [];
    for (const para of String(text ?? '').split(/\r?\n/)) {
      let line = '';
      for (const word of this.safe(para).split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= max || !line) line = next;
        else { out.push(line); line = word; }
      }
      out.push(line);
    }
    return out.map((l) => this.fit(l, size, max, font));
  }
  text(text, x, y, { size = 9, font = this.regular, color = INK, align = 'left', max } = {}) {
    const t = max ? this.fit(text, size, max, font) : this.safe(text);
    const w = font.widthOfTextAtSize(t, size);
    const left = align === 'right' ? x - w : align === 'center' ? x - w / 2 : x;
    this.page.drawText(t, { x: left, y, size, font, color });
  }
  rule(y, x1 = M, x2 = A4[0] - M, color = RULE) { this.page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: 0.6, color }); }
  ensure(height) { if (this.y - height < M + 28) { this.newPage(); return true; } return false; }

  /** The hospital's letterhead on the left, the document title and its facts on the right. */
  header(issuer, title, facts) {
    const top = this.y;
    this.text(issuer.name, M, top - 14, { size: 15, font: this.bold, max: 300 });
    let y = top - 30;
    for (const l of [issuer.address, [issuer.phone, issuer.email].filter(Boolean).join('  ·  '), issuer.tin ? `TIN ${issuer.tin}` : '', issuer.rcNumber ? `RC ${issuer.rcNumber}` : ''].filter(Boolean)) {
      for (const w of this.wrap(l, 8.5, 290)) { this.text(w, M, y, { size: 8.5, color: MUTED }); y -= 11; }
    }
    const right = A4[0] - M;
    this.text(title.toUpperCase(), right, top - 14, { size: 15, font: this.bold, align: 'right' });
    let fy = top - 32;
    for (const [label, value] of facts.filter(([, v]) => v !== undefined && v !== null && v !== '')) {
      this.text(label, right - 120, fy, { size: 8.5, color: MUTED, align: 'right' });
      this.text(value, right, fy, { size: 8.5, font: this.bold, align: 'right', max: 110 });
      fy -= 12;
    }
    this.y = Math.min(y, fy) - 10;
    this.rule(this.y);
    this.y -= 18;
  }
  /** A labelled block of lines (bill to, pay to). */
  block(label, lines, x = M, width = 260) {
    this.text(label.toUpperCase(), x, this.y, { size: 7.5, font: this.bold, color: MUTED });
    let y = this.y - 13;
    lines.filter(Boolean).forEach((l, i) => { for (const w of this.wrap(l, i === 0 ? 10 : 8.5, width, i === 0 ? this.bold : this.regular)) { this.text(w, x, y, { size: i === 0 ? 10 : 8.5, font: i === 0 ? this.bold : this.regular }); y -= i === 0 ? 13 : 11; } });
    return y;
  }
  /** A table; columns are { label, width, align }; rows are arrays of strings. Breaks across pages. */
  table(columns, rows, { emptyText = 'Nothing to show.' } = {}) {
    const xs = [];
    let x = M;
    for (const c of columns) { xs.push(x); x += c.width; }
    const head = () => {
      this.page.drawRectangle({ x: M, y: this.y - 5, width: A4[0] - 2 * M, height: 17, color: BAND });
      columns.forEach((c, i) => this.text(c.label, c.align === 'right' ? xs[i] + c.width - 4 : xs[i] + 4, this.y, { size: 8, font: this.bold, color: MUTED, align: c.align === 'right' ? 'right' : 'left' }));
      this.y -= 18;
    };
    this.ensure(40);
    head();
    if (!rows.length) { this.text(emptyText, M + 4, this.y, { size: 9, color: MUTED }); this.y -= 16; return; }
    for (const row of rows) {
      // the first left-aligned wide column wraps; the rest are cut to fit
      const wrapped = row.map((cell, i) => (columns[i].wrap ? this.wrap(cell, 9, columns[i].width - 8) : [this.fit(cell, 9, columns[i].width - 8, row.bold ? this.bold : this.regular)]));
      const height = Math.max(...wrapped.map((w) => w.length)) * 11 + 5;
      if (this.ensure(height + 4)) head();
      wrapped.forEach((ls, i) => ls.forEach((l, j) => this.text(l, columns[i].align === 'right' ? xs[i] + columns[i].width - 4 : xs[i] + 4, this.y - j * 11, { size: 9, font: row.bold ? this.bold : this.regular, align: columns[i].align === 'right' ? 'right' : 'left' })));
      this.y -= height;
      this.rule(this.y + 7);
    }
    this.y -= 6;
  }
  /** Label / amount pairs aligned to the right edge; the last can be emphasised. */
  totals(pairs) {
    const right = A4[0] - M;
    this.ensure(pairs.length * 15 + 10);
    for (const p of pairs) {
      const strong = p.strong;
      if (strong) { this.rule(this.y + 10, right - 230, right, INK); }
      this.text(p.label, right - 120, this.y, { size: strong ? 10 : 9, font: strong ? this.bold : this.regular, color: strong ? INK : MUTED, align: 'right' });
      this.text(p.value, right, this.y, { size: strong ? 10 : 9, font: strong ? this.bold : this.regular, align: 'right' });
      this.y -= strong ? 18 : 14;
    }
  }
  /** A titled paragraph (payment instructions, notes). */
  note(title, body) {
    if (!body) return;
    const lines = this.wrap(body, 8.5, A4[0] - 2 * M);
    this.ensure(lines.length * 11 + 22);
    this.text(title.toUpperCase(), M, this.y, { size: 7.5, font: this.bold, color: MUTED });
    this.y -= 13;
    for (const l of lines) { this.text(l, M, this.y, { size: 8.5 }); this.y -= 11; }
    this.y -= 8;
  }
  async finish(footer) {
    const pages = this.doc.getPages();
    pages.forEach((p, i) => {
      this.page = p;
      this.rule(M - 2);
      this.text(footer, M, M - 14, { size: 7.5, color: MUTED, max: 380 });
      this.text(`Page ${i + 1} of ${pages.length}`, A4[0] - M, M - 14, { size: 7.5, color: MUTED, align: 'right' });
    });
    return Buffer.from(await this.doc.save());
  }
}

const generated = (issuer) => `${issuer.name} · generated ${day(new Date())}`;

/**
 * An invoice. data: { issuer, customer: { name, address, city, email, phone }, invoice: { number, date, dueDate,
 * status, currency, notes, lines: [{ description, qty, unitPrice, amount, tax }], subtotal, taxes: [{ label, amount }],
 * total, paid, balance } }
 */
export async function renderInvoicePdf({ issuer, customer, invoice }) {
  const s = await Sheet.create(`Invoice ${invoice.number}`);
  const cur = invoice.currency ?? 'NGN';
  s.header(issuer, invoice.kindLabel ?? 'Invoice', [['Invoice no.', invoice.number], ['Date', day(invoice.date)], ['Due', day(invoice.dueDate)], ['Status', invoice.status], ['Currency', cur]]);
  const after = s.block('Bill to', [customer.name, customer.address, customer.city, customer.email, customer.phone]);
  s.y = after - 12;
  s.table(
    [{ label: 'Description', width: 251, wrap: true }, { label: 'Qty', width: 46, align: 'right' }, { label: 'Unit price', width: 96, align: 'right' }, { label: 'Amount', width: 106, align: 'right' }],
    invoice.lines.map((l) => [l.description, String(Number(l.qty)), plain(l.unitPrice), plain(l.amount)]),
  );
  s.totals([
    { label: 'Subtotal', value: pdfMoney(invoice.subtotal, cur) },
    ...invoice.taxes.map((t) => ({ label: t.label, value: pdfMoney(t.amount, cur) })),
    { label: 'Total', value: pdfMoney(invoice.total, cur) },
    ...(invoice.paid > 0 ? [{ label: 'Paid and credited', value: pdfMoney(-invoice.paid, cur) }] : []),
    { label: 'Balance due', value: pdfMoney(invoice.balance, cur), strong: true },
  ]);
  s.y -= 6;
  s.note('Notes', invoice.notes);
  s.note('How to pay', issuer.paymentInstructions);
  return s.finish(`${generated(issuer)} · Please quote ${invoice.number} with your payment.`);
}

/**
 * A statement of account. data: { issuer, party: { name, address, city, email, phone, label }, statement: { from, to,
 * currency, openingBalance, closingBalance, lines: [{ date, reference, description, debit, credit, balance }],
 * aging: [{ label, amount }], open: [{ number, date, dueDate, total, balance, overdue }] }, perspective: 'customer'|'vendor' }
 */
export async function renderStatementPdf({ issuer, party, statement, perspective = 'customer' }) {
  const s = await Sheet.create(`Statement — ${party.name}`);
  const cur = statement.currency ?? 'NGN';
  const owes = perspective === 'customer' ? 'Amount due' : 'Amount we owe';
  s.header(issuer, 'Statement of account', [['Period from', day(statement.from)], ['Period to', day(statement.to)], ['Currency', cur], [owes, pdfMoney(statement.closingBalance, cur)]]);
  const after = s.block(perspective === 'customer' ? 'Statement for' : 'Supplier', [party.name, party.address, party.city, party.email, party.phone]);
  s.y = after - 12;
  const rows = [
    Object.assign([day(statement.from), '', 'Opening balance', '', '', plain(statement.openingBalance)], { bold: true }),
    ...statement.lines.map((l) => [day(l.date), l.reference ?? '', l.description ?? '', l.debit ? plain(l.debit) : '', l.credit ? plain(l.credit) : '', plain(l.balance)]),
    Object.assign([day(statement.to), '', 'Closing balance', '', '', plain(statement.closingBalance)], { bold: true }),
  ];
  const [dr, cr] = perspective === 'customer' ? ['Charges', 'Payments'] : ['Payments', 'Bills'];
  s.table([
    { label: 'Date', width: 66 }, { label: 'Reference', width: 82 }, { label: 'Details', width: 151, wrap: true },
    { label: dr, width: 66, align: 'right' }, { label: cr, width: 66, align: 'right' }, { label: 'Balance', width: 68, align: 'right' },
  ], rows);
  if (statement.open?.length) {
    s.y -= 4; s.ensure(30);
    s.text(perspective === 'customer' ? 'OPEN INVOICES' : 'OPEN BILLS', M, s.y, { size: 7.5, font: s.bold, color: MUTED }); s.y -= 12;
    s.table([{ label: 'Number', width: 104 }, { label: 'Date', width: 72 }, { label: 'Due', width: 72 }, { label: 'Status', width: 55 }, { label: 'Total', width: 96, align: 'right' }, { label: 'Balance', width: 100, align: 'right' }],
      statement.open.map((o) => [o.number, day(o.date), day(o.dueDate), o.overdue ? 'Overdue' : 'Due', pdfMoney(o.total, o.currency ?? cur), pdfMoney(o.balance, o.currency ?? cur)]));
  }
  if (statement.aging?.length) {
    s.ensure(48);
    s.text('AGEING', M, s.y, { size: 7.5, font: s.bold, color: MUTED }); s.y -= 12;
    s.table(statement.aging.map((a) => ({ label: a.label, width: 499 / statement.aging.length, align: 'right' })), [statement.aging.map((a) => plain(a.amount))]);
  }
  s.totals([{ label: owes, value: pdfMoney(statement.closingBalance, cur), strong: true }]);
  if (perspective === 'customer') s.note('How to pay', issuer.paymentInstructions);
  return s.finish(`${generated(issuer)} · Please tell us within 14 days if anything here looks wrong.`);
}

/**
 * Remittance advice for a supplier payment. data: { issuer, vendor, payment: { number, date, method, reference,
 * amount, withheldTax, currency, allocations: [{ number, vendorInvoiceNumber, date, amount }] } }
 */
export async function renderRemittancePdf({ issuer, vendor, payment }) {
  const s = await Sheet.create(`Remittance ${payment.number}`);
  const cur = payment.currency ?? 'NGN';
  s.header(issuer, 'Remittance advice', [['Payment no.', payment.number], ['Date', day(payment.date)], ['Method', payment.method], ['Reference', payment.reference]]);
  const after = s.block('Paid to', [vendor.name, vendor.address, vendor.city, vendor.email, vendor.phone]);
  s.y = after - 12;
  s.table([{ label: 'Our ref.', width: 110 }, { label: 'Your invoice', width: 130 }, { label: 'Bill date', width: 110 }, { label: 'Amount settled', width: 149, align: 'right' }],
    payment.allocations.map((a) => [a.number, a.vendorInvoiceNumber ?? '', day(a.date), plain(a.amount)]), { emptyText: 'Paid on account (not yet applied to a bill).' });
  const settled = payment.allocations.reduce((n, a) => n + Number(a.amount), 0);
  s.totals([
    { label: 'Bills settled', value: pdfMoney(settled, cur) },
    ...(payment.withheldTax > 0 ? [{ label: 'Withholding tax deducted', value: pdfMoney(-payment.withheldTax, cur) }] : []),
    { label: 'Amount paid', value: pdfMoney(payment.amount, cur), strong: true },
  ]);
  if (payment.withheldTax > 0) s.note('Withholding tax', 'Tax withheld from this payment is remitted to the tax authority on your behalf; a credit note for it can be requested from our accounts team.');
  return s.finish(`${generated(issuer)} · Payment ${payment.number}`);
}

/** Sends a rendered document: inline for viewing in the browser, or as a download. Never cached. */
export function sendPdf(res, { filename, bytes }, { download = false } = {}) {
  res.set({
    'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${filename.replace(/["\\\r\n]/g, '')}"`,
  });
  res.status(200).end(bytes);
}
