import { describe, expect, it } from 'vitest';
import { buildSummary } from '../../src/modules/emr/wardrounds/wardrounds.service.js';

const round = (iso) => ({ roundAt: new Date(iso), clinicalProgress: 'Improving', progressNote: 'Afebrile.', problems: [{ problem: 'CAP', status: 'Improving', plan: 'Antibiotics' }], tasks: [{ type: 'Repeat vitals', description: '4-hourly' }] });

describe('ward round summary', () => {
  it("stamps the hospital's local time (Lagos), not UTC", () => {
    expect(buildSummary(round('2026-10-21T15:29:00.000Z'), 'Tunde Bakare').split('\n')[0]).toBe('Ward round — 2026-10-21 16:29 — Tunde Bakare');
    // across midnight the date moves too
    expect(buildSummary(round('2026-10-21T23:30:00.000Z'), 'Tunde Bakare').split('\n')[0]).toBe('Ward round — 2026-10-22 00:30 — Tunde Bakare');
  });
  it('only repeats what the clinician entered', () => {
    expect(buildSummary(round('2026-10-21T15:29:00.000Z'), 'T').split('\n').slice(1)).toEqual(['Progress: Improving', 'Afebrile.', 'Problems:', '- CAP (Improving): Antibiotics', 'Plan:', '- [Repeat vitals] 4-hourly']);
  });
});
