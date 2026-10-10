import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../src/config/db.js", () => ({ default: {} }));
const {
  reminderStage,
  sendPharmacyEmail,
  deliverPharmacyEmail,
  pharmacyAccessUrl,
} = await import("../src/modules/pharmacies/portal.email.js");
const { csvCell, toCsv, reportWindow } =
  await import("../src/modules/pharmacies/portal.reports.js");
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("pharmacy operations safeguards", () => {
  it("uses renewal windows without repeating every day or backfilling all missed stages", () => {
    const now = new Date("2026-10-10T12:00:00Z");
    expect(
      [31, 30, 20, 14, 8, 7, 2, 1, 0, -1].map((d) =>
        reminderStage(new Date(now.getTime() + d * 86400000), now),
      ),
    ).toEqual([
      null,
      "30",
      "30",
      "14",
      "14",
      "7",
      "7",
      "1",
      "EXPIRED",
      "EXPIRED",
    ]);
    expect(reminderStage(null, now)).toBe(null);
  });
  it("validates Lagos report dates and rejects rollover/reversed/oversized ranges", () => {
    expect(reportWindow("2026-10-10", "2026-10-10")).toEqual({
      start: new Date("2026-10-09T23:00:00Z"),
      end: new Date("2026-10-10T23:00:00Z"),
    });
    for (const dates of [
      ["2026-02-31", "2026-03-03"],
      ["2026-10-11", "2026-10-10"],
      ["2025-01-01", "2026-10-10"],
    ])
      expect(() => reportWindow(...dates)).toThrow();
  });
  it("escapes spreadsheet formulas, quotes and newlines without dropping CSV data", () => {
    for (const value of [
      '=HYPERLINK("https://evil.test")',
      " +2",
      "@SUM(1)",
      "\tformula",
      "-10",
    ])
      expect(csvCell(value)).toMatch(/^"'/);
    expect(toCsv(["name"], [['normal "quote"\nline']])).toContain(
      '"normal ""quote""\nline"',
    );
  });
  it("refuses email portal URLs containing credentials or non-HTTPS origins", () => {
    vi.stubEnv("PHARMACY_PORTAL_URL", "http://example.test");
    expect(() => pharmacyAccessUrl()).toThrow();
    vi.stubEnv("PHARMACY_PORTAL_URL", "https://user:secret@example.test");
    expect(() => pharmacyAccessUrl()).toThrow();
  });
  it("uses a stable Resend idempotency key and never follows redirects", async () => {
    vi.stubEnv("RESEND_API_KEY", "synthetic-test-key");
    const fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ id: "synthetic-provider-id" }),
    }));
    vi.stubGlobal("fetch", fetch);
    expect(
      await sendPharmacyEmail({
        id: "job-test",
        sender: "sender@sabi.test",
        recipient: "owner@sabi.test",
        subject: "Approved",
        text: "Sign in using Sabi ID.",
      }),
    ).toEqual({ sent: true, providerId: "synthetic-provider-id" });
    expect(fetch.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          "Idempotency-Key": "pharmacy/job-test",
        }),
      }),
    );
  });
  it("retries outages/quota errors but does not retry permanent provider rejection", async () => {
    for (const status of [429, 503, 403]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status })),
      );
      expect(await sendPharmacyEmail({ id: "test" })).toEqual({
        sent: false,
        retryable: status !== 403,
        code: `PROVIDER_HTTP_${status}`,
      });
    }
  });
  function fakeDb(extra = {}) {
    const now = new Date("2026-10-10T12:00:00Z");
    const p = {
      complianceStatus: "VERIFIED",
      admin: {
        accountStatus: "ACTIVE",
        emailVerifiedAt: now,
        email: "owner@sabi.test",
      },
      branches: [],
      superintendentLicenceExpiresAt: new Date("2027-01-01Z"),
    };
    const candidate = {
      id: "job-test",
      recipient: p.admin.email,
      sender: "sender@sabi.test",
      expectedStatus: "VERIFIED",
      licenceExpiry: null,
      attempts: 0,
      firstAttemptAt: null,
      pharmacy: p,
      ...extra,
    };
    const db = {
      $queryRaw: vi.fn(async () => [{ id: candidate.id }]),
      pharmacyEmailJob: {
        findUnique: vi.fn(async () => candidate),
        update: vi.fn(async ({ data }) => ({
          ...candidate,
          ...data,
          attempts: candidate.attempts + 1,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    db.$transaction = vi.fn((fn) => fn(db));
    return { db, now };
  }
  it("records provider acceptance using a lease compare-and-set", async () => {
    const { db, now } = fakeDb();
    const send = vi.fn(async () => ({ sent: true, providerId: "test-id" }));
    expect(
      await deliverPharmacyEmail({
        db,
        now,
        send,
        configured: () => true,
        allowed: () => true,
      }),
    ).toEqual({ claimed: true, sent: true });
    expect(db.pharmacyEmailJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "QUEUED",
          leaseToken: expect.any(String),
        }),
        data: expect.objectContaining({ status: "SENT", leaseToken: null }),
      }),
    );
  });
  it("cancels superseded decisions and expired/renewed licence reminders without sending", async () => {
    for (const extra of [
      { expectedStatus: "REJECTED" },
      { licenceExpiry: new Date("2026-01-01Z") },
      { recipient: "old-address@sabi.test" },
    ]) {
      const { db, now } = fakeDb(extra),
        send = vi.fn();
      await deliverPharmacyEmail({
        db,
        now,
        send,
        configured: () => true,
        allowed: () => true,
      });
      expect(send).not.toHaveBeenCalled();
      expect(db.pharmacyEmailJob.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "CANCELLED" }),
        }),
      );
    }
  });
  it('backs off transient failures, stops after six attempts and ignores stale lease acknowledgements', async () => {
    for (const attempts of [0, 5]) {
      const {db, now} = fakeDb({attempts});
      await deliverPharmacyEmail({db, now, send: async () => ({sent:false,retryable:true,code:'PROVIDER_HTTP_429'}), configured:()=>true, allowed:()=>true});
      expect(db.pharmacyEmailJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status: attempts===5?'FAILED':'QUEUED', nextAttemptAt:new Date(now.getTime() + (attempts===5?1800000:60000))})}));
    }
    const {db, now} = fakeDb(); db.pharmacyEmailJob.updateMany.mockResolvedValue({count:0});
    expect(await deliverPharmacyEmail({db, now, send:async()=>({sent:true,providerId:'test'}), configured:()=>true, allowed:()=>true})).toEqual({claimed:true,sent:false});
  });
  it('does not send when unconfigured, no lease is claimable, or recipient is disallowed', async () => {
    const {db, now} = fakeDb(),send=vi.fn();
    await deliverPharmacyEmail({db, now, send, configured:()=>false}); expect(db.$transaction).not.toHaveBeenCalled();
    db.$queryRaw.mockResolvedValueOnce([]);
    await deliverPharmacyEmail({db, now, send, configured:()=>true}); expect(send).not.toHaveBeenCalled();
    await deliverPharmacyEmail({db, now, send, configured:()=>true,allowed:()=>false});
    expect(send).not.toHaveBeenCalled();expect(db.pharmacyEmailJob.update).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({status:'FAILED',lastErrorCode:'RECIPIENT_NOT_ALLOWED'})}));
  });
  it("stops automatic retries before Resend idempotency expires", async () => {
    const { db, now } = fakeDb({
        firstAttemptAt: new Date("2026-10-09T12:00:00Z"),
      }),
      send = vi.fn();
    await deliverPharmacyEmail({
      db,
      now,
      send,
      configured: () => true,
      allowed: () => true,
    });
    expect(send).not.toHaveBeenCalled();
    expect(db.pharmacyEmailJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorCode: "RETRY_WINDOW_EXPIRED",
        }),
      }),
    );
  });
});
