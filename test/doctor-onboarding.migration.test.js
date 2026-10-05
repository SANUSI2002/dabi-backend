import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';

it('applies the release migration chain and enforces private credential relationships', async () => {
  const db = await PGlite.create();
  try {
    const root = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
    for (const entry of (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) await db.exec(await readFile(join(root, entry.name, 'migration.sql'), 'utf8'));
    const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'DoctorCredential'");
    expect(columns.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining(['applicationId', 'storageBucket', 'sha256', 'scanStatus', 'scannerVersion', 'scannedAt', 'reviewStatus', 'reviewedBy']));
    await expect(db.exec(`INSERT INTO "DoctorApplication" (id, "professionalId", details, "consentVersion") VALUES ('synthetic-app', 'nonexistent-doctor', '{}', 'test')`)).rejects.toThrow();
    await expect(db.exec(`INSERT INTO "DoctorCredential" (id, "applicationId", kind, "storageKey", "contentType", "byteSize", sha256) VALUES ('synthetic-doc', 'nonexistent-app', 'licence', 'test.pdf', 'application/pdf', 10, 'synthetic')`)).rejects.toThrow();
  } finally { await db.close(); }
}, 60000);
