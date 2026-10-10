import { Buffer, Blob } from "node:buffer";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
const bytes = Buffer.from("%PDF-1.7\nsynthetic pharmacy licence");
const job = {
  id: "credential-test",
  pharmacyId: "pharmacy-test",
  pharmacy: { adminUserId: "owner-test" },
  storageBucket: "sabi-hospital-evidence-quarantine",
  storageKey: "synthetic.pdf",
  byteSize: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  contentType: "application/pdf",
  scanAttempts: 0,
  scanStatus: "PENDING",
};
const db = {
  pharmacyCredential: { findMany: vi.fn(), updateMany: vi.fn() },
  activityLog: { create: vi.fn() },
  $transaction: vi.fn(),
};
vi.mock("../src/config/db.js", () => ({ default: db }));
const { processPharmacyCredentialJob } =
  await import("../src/modules/pharmacies/portal.scanner.js");
const quarantine = { download: vi.fn(), remove: vi.fn() },
  clean = { upload: vi.fn() };
const client = {
  storage: {
    getBucket: vi.fn(),
    from: (bucket) =>
      bucket === "sabi-hospital-evidence-clean" ? clean : quarantine,
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  db.$transaction.mockImplementation((work) => work(db));
  db.pharmacyCredential.findMany.mockResolvedValue([job]);
  db.pharmacyCredential.updateMany.mockResolvedValue({ count: 1 });
  client.storage.getBucket.mockResolvedValue({ data: { public: false } });
  quarantine.download.mockResolvedValue({ data: new Blob([bytes]) });
  clean.upload.mockResolvedValue({ data: { path: "clean.pdf" } });
  quarantine.remove.mockResolvedValue({});
});
describe("pharmacy credential screening queue", () => {
  it("releases only clean content into private storage, then records provenance and cleans quarantine", async () => {
    const scan = vi.fn(async () => ({
      verdict: "CLEAN",
      scannerVersion: "Synthetic scanner",
    }));
    expect(await processPharmacyCredentialJob({ db, client, scan })).toBe(true);
    expect(scan).toHaveBeenCalledWith(bytes, job);
    expect(clean.upload.mock.calls[0][2].upsert).toBe(false);
    expect(db.pharmacyCredential.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scanStatus: "CLEAN",
          storageBucket: "sabi-hospital-evidence-clean",
          scannerVersion: "Synthetic scanner",
        }),
      }),
    );
    expect(db.activityLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: "PHARMACY_SCAN_CLEAN",
          meta: expect.objectContaining({ actorKind: "SYSTEM_SCANNER" }),
        }),
      }),
    );
    expect(quarantine.remove).toHaveBeenCalledWith([job.storageKey]);
    expect(
      db.pharmacyCredential.updateMany.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(quarantine.remove.mock.invocationCallOrder[0]);
  });
  it.each(["INFECTED", "REJECTED"])(
    "keeps %s content inaccessible",
    async (verdict) => {
      await processPharmacyCredentialJob({
        db,
        client,
        scan: async () => ({ verdict, scannerVersion: "Synthetic scanner" }),
      });
      expect(clean.upload).not.toHaveBeenCalled();
      expect(quarantine.remove).not.toHaveBeenCalled();
      expect(db.pharmacyCredential.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ scanStatus: verdict }),
        }),
      );
    },
  );
  it("does not scan a claimed job twice or publish an expired lease", async () => {
    db.pharmacyCredential.updateMany.mockResolvedValueOnce({ count: 0 });
    const scan = vi.fn();
    expect(await processPharmacyCredentialJob({ db, client, scan })).toBe(
      false,
    );
    expect(scan).not.toHaveBeenCalled();
    db.pharmacyCredential.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    await processPharmacyCredentialJob({
      db,
      client,
      scan: async () => ({ verdict: "CLEAN", scannerVersion: "Synthetic" }),
    });
    expect(db.activityLog.create).not.toHaveBeenCalled();
    expect(quarantine.remove).not.toHaveBeenCalled();
  });
  it("fails closed on a content hash mismatch before sending bytes to the provider", async () => {
    quarantine.download.mockResolvedValue({ data: new Blob(["tampered"]) });
    const scan = vi.fn();
    await processPharmacyCredentialJob({ db, client, scan });
    expect(scan).not.toHaveBeenCalled();
    expect(db.pharmacyCredential.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scanStatus: "FAILED",
          scanErrorCode: "EVIDENCE_INTEGRITY_MISMATCH",
        }),
      }),
    );
  });
  it("backs off rate limits, exhausts retries, and never treats uncertain replies as clean", async () => {
    const scan = async () => {
      throw new Error("CLOUDMERSIVE_RATE_LIMITED");
    };
    await processPharmacyCredentialJob({ db, client, scan });
    expect(db.pharmacyCredential.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scanStatus: "PENDING",
          scanLeaseExpiresAt: expect.any(Date),
        }),
      }),
    );
    db.pharmacyCredential.findMany.mockResolvedValue([
      { ...job, scanAttempts: 4 },
    ]);
    await processPharmacyCredentialJob({ db, client, scan });
    expect(db.pharmacyCredential.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scanStatus: "FAILED" }),
      }),
    );
    db.pharmacyCredential.findMany.mockResolvedValue([job]);
    await processPharmacyCredentialJob({
      db,
      client,
      scan: async () => ({ verdict: "CLEAN" }),
    });
    expect(clean.upload).not.toHaveBeenCalled();
  });
});
