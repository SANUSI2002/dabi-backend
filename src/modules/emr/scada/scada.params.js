// Telemetry parameters per equipment category, with the thresholds the server judges each reading by.
// The same table as the screens' src/data/equipmentTelemetry.ts (keep the two in step). These are
// illustrative reference ranges, not a validated clinical or engineering threshold table; a hospital's
// biomedical engineers should review them before relying on the alarms.
export const TELEMETRY_PARAMS = {
  'Laboratory Analyzer': [
    { key: 'throughput', label: 'Throughput', unit: 'tests/hr', min: 0, max: 120, normalMin: 10, normalMax: 100 },
    { key: 'reagentTemp', label: 'Reagent Temperature', unit: '°C', min: 0, max: 40, normalMin: 4, normalMax: 8, warningMax: 10, criticalMax: 15 },
  ],
  'Radiology Imaging': [
    { key: 'tubeTemp', label: 'Tube Temperature', unit: '°C', min: 15, max: 90, normalMin: 20, normalMax: 55, warningMax: 65, criticalMax: 80 },
    { key: 'exposures', label: 'Exposures Today', unit: 'count', min: 0, max: 200, normalMin: 0, normalMax: 200 },
  ],
  'ICU Device': [
    { key: 'fio2', label: 'FiO2', unit: '%', min: 21, max: 100, normalMin: 21, normalMax: 60, warningMax: 80, criticalMax: 100 },
    { key: 'peep', label: 'PEEP', unit: 'cmH2O', min: 0, max: 20, normalMin: 4, normalMax: 10, warningMax: 14, criticalMax: 18 },
    { key: 'respRate', label: 'Respiratory Rate', unit: '/min', min: 5, max: 40, normalMin: 12, normalMax: 20, warningMax: 28, criticalMax: 35 },
    { key: 'spo2', label: 'SpO2', unit: '%', min: 60, max: 100, normalMin: 94, normalMax: 100, warningMin: 90, criticalMin: 85 },
    { key: 'hr', label: 'Heart Rate', unit: 'bpm', min: 30, max: 200, normalMin: 60, normalMax: 100, warningMax: 130, criticalMax: 160, warningMin: 50, criticalMin: 40 },
  ],
  'Theatre Equipment': [
    { key: 'power', label: 'Output Power', unit: 'W', min: 0, max: 300, normalMin: 0, normalMax: 200, warningMax: 250, criticalMax: 290 },
  ],
  'Dialysis Equipment': [
    { key: 'bloodFlow', label: 'Blood Flow', unit: 'mL/min', min: 0, max: 500, normalMin: 200, normalMax: 400, warningMin: 150, criticalMin: 100 },
    { key: 'dialysateFlow', label: 'Dialysate Flow', unit: 'mL/min', min: 0, max: 1000, normalMin: 400, normalMax: 800 },
    { key: 'ufRate', label: 'UF Rate', unit: 'mL/hr', min: 0, max: 2000, normalMin: 0, normalMax: 1000, warningMax: 1500, criticalMax: 1800 },
    { key: 'conductivity', label: 'Conductivity', unit: 'mS/cm', min: 10, max: 16, normalMin: 13, normalMax: 15, warningMax: 15.5, criticalMax: 16 },
  ],
  'Pharmacy Cold Chain': [
    { key: 'temperature', label: 'Temperature', unit: '°C', min: -5, max: 20, normalMin: 2, normalMax: 8, warningMax: 10, criticalMax: 12, warningMin: 1, criticalMin: -1 },
    { key: 'doorOpenSec', label: 'Door Open Duration', unit: 'sec', min: 0, max: 600, normalMin: 0, normalMax: 30, warningMax: 90, criticalMax: 180 },
  ],
  'Generator': [
    { key: 'voltage', label: 'Voltage', unit: 'V', min: 180, max: 260, normalMin: 220, normalMax: 240, warningMin: 210, criticalMin: 200, warningMax: 245, criticalMax: 250 },
    { key: 'frequency', label: 'Frequency', unit: 'Hz', min: 45, max: 55, normalMin: 49.5, normalMax: 50.5, warningMax: 51, criticalMax: 52, warningMin: 49, criticalMin: 48 },
    { key: 'fuel', label: 'Fuel Level', unit: '%', min: 0, max: 100, normalMin: 30, normalMax: 100, warningMin: 20, criticalMin: 10 },
    { key: 'oilPressure', label: 'Oil Pressure', unit: 'bar', min: 0, max: 6, normalMin: 2, normalMax: 4.5, warningMin: 1.5, criticalMin: 1 },
    { key: 'engineTemp', label: 'Engine Temperature', unit: '°C', min: 40, max: 130, normalMin: 70, normalMax: 95, warningMax: 105, criticalMax: 115 },
  ],
  'HVAC': [
    { key: 'supplyTemp', label: 'Supply Temperature', unit: '°C', min: 10, max: 30, normalMin: 18, normalMax: 22, warningMax: 24, criticalMax: 27 },
    { key: 'humidity', label: 'Humidity', unit: '%RH', min: 20, max: 80, normalMin: 40, normalMax: 60, warningMax: 65, criticalMax: 70 },
  ],
  'Medical Gas': [
    { key: 'o2Pressure', label: 'Oxygen Pressure', unit: 'bar', min: 0, max: 6, normalMin: 3.5, normalMax: 4.5, warningMin: 3, criticalMin: 2.5 },
    { key: 'vacuumPressure', label: 'Vacuum Pressure', unit: 'kPa', min: -80, max: 0, normalMin: -60, normalMax: -40, warningMax: -30, criticalMax: -20 },
    { key: 'tankLevel', label: 'Tank Level', unit: '%', min: 0, max: 100, normalMin: 30, normalMax: 100, warningMin: 20, criticalMin: 10 },
  ],
  'Water Treatment': [
    { key: 'tankLevel', label: 'Tank Level', unit: '%', min: 0, max: 100, normalMin: 30, normalMax: 100, warningMin: 20, criticalMin: 10 },
    { key: 'pressure', label: 'Line Pressure', unit: 'bar', min: 0, max: 6, normalMin: 2, normalMax: 4, warningMin: 1, criticalMin: 0.5 },
  ],
  'Solar / Inverter': [
    { key: 'battery', label: 'Battery', unit: '%', min: 0, max: 100, normalMin: 40, normalMax: 100, warningMin: 25, criticalMin: 10 },
    { key: 'outputVoltage', label: 'Output Voltage', unit: 'V', min: 180, max: 260, normalMin: 220, normalMax: 240 },
  ],
  'Elevator': [
    { key: 'cycles', label: 'Cycles Today', unit: 'count', min: 0, max: 500, normalMin: 0, normalMax: 400 },
  ],
  'Other Infrastructure': [
    { key: 'status', label: 'Signal', unit: '', min: 0, max: 100, normalMin: 40, normalMax: 100 },
  ],
};

/** Normal, Warning or Critical — the same rule as the screens. */
export function severityFor(def, value) {
  if (def.criticalMax !== undefined && value >= def.criticalMax) return 'Critical';
  if (def.criticalMin !== undefined && value <= def.criticalMin) return 'Critical';
  if (def.warningMax !== undefined && value >= def.warningMax) return 'Warning';
  if (def.warningMin !== undefined && value <= def.warningMin) return 'Warning';
  if (value > def.normalMax || value < def.normalMin) return 'Warning';
  return 'Normal';
}
/** The threshold a reading crossed (for the alarm), or null. */
export function thresholdCrossed(def, value) {
  for (const t of [def.criticalMax, def.warningMax]) if (t !== undefined && value >= t) return t;
  for (const t of [def.criticalMin, def.warningMin]) if (t !== undefined && value <= t) return t;
  if (value > def.normalMax) return def.normalMax;
  if (value < def.normalMin) return def.normalMin;
  return null;
}
export const CATEGORIES = Object.keys(TELEMETRY_PARAMS);
