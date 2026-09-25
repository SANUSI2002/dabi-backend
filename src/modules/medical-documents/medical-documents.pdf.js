const pdfEscape = (value) =>
  String(value ?? "")
    .replace(/[\\()]/g, "\\$&")
    .replace(/[^\x20-\x7e]/g, "?");

export const buildEmergencySummaryPdf = (data) => {
  const profile = data?.profile || {};
  const lines = [
    "Emergency Summary",
    `Patient name: ${data?.full_name || "Not provided"}`,
    `Patient reference: ${data?.patientId || "Not provided"}`,
    `Date of birth: ${data?.dob ? new Date(data.dob).toISOString().slice(0, 10) : "Not provided"}`,
    `Blood type: ${profile.blood_type || "Not provided"}`,
    `Known allergies: ${profile.known_allergies || "Not provided"}`,
    `Chronic conditions: ${profile.chronic_conditions || "Not provided"}`,
    `Emergency contact: ${profile.emergencyContactName || "Not provided"}`,
    `Emergency contact phone: ${profile.emergencyContactPhone || "Not provided"}`,
    `Emergency contact relationship: ${profile.emergencyContactRelation || "Not provided"}`,
    `Emergency access permissions: ${(profile.emergency_access_permissions || []).join(", ") || "None"}`,
    `Electronic health records enabled: ${profile.electronic_health_records === true ? "Yes" : "No"}`,
    `Consent given: ${profile.consentGiven === true ? "Yes" : "No"}`,
  ];
  const content = [
    "BT",
    "/F1 11 Tf",
    "50 790 Td",
    ...lines.flatMap((line, index) => [
      `(${pdfEscape(line)}) Tj`,
      ...(index < lines.length - 1 ? ["0 -24 Td"] : []),
    ]),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n `)
    .join("\n")}\n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
};
import { Buffer } from "node:buffer";
