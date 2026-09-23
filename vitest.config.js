import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node', clearMocks: true, restoreMocks: true, coverage: { provider: 'v8', include: ['src/modules/hospital-plans/**/*.js', 'src/modules/organisations/**/*.js', 'src/modules/caregivers/**/*.js','src/modules/auth/**/*.js', 'src/modules/profile/**/*.js', 'src/modules/dashboard/**/*.js', 'src/modules/appointments/**/*.js', 'src/modules/medications/**/*.js', 'src/modules/vitals/**/*.js', 'src/modules/health-metrics/**/*.js', 'src/modules/medical-records/**/*.js', 'src/modules/family-care/**/*.js', 'src/modules/professionals/**/*.js', 'src/modules/doctor-care/**/*.js', 'src/modules/prescriptions/**/*.js', 'src/modules/pharmacies/**/*.js', 'src/modules/inventory/**/*.js', 'src/modules/pharmacy-requests/**/*.js'], thresholds: { lines: 15, functions: 15, branches: 10, statements: 15 } } },
});
