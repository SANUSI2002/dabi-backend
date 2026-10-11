import { randomUUID } from "node:crypto";
import { Buffer, Blob } from "node:buffer";
import { URL } from "node:url";
import request from "supertest";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { prisma, tokenFor } from "./fixtures.js";
const email = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ delivered: true }),
}));
vi.mock("../../src/modules/auth/auth.email.js", () => ({
  verificationEmailConfigured: () => true,
  verificationEmailAllowedFor: () => true,
  sendEmailVerificationEmail: email.send,
  passwordResetEmailConfigured: () => false,
  passwordResetEmailAllowedFor: () => false,
  sendPasswordResetEmail: vi.fn(),
}));
const objects = new Map();
const storage = {
  storage: {
    getBucket: async () => ({ data: { public: false } }),
    from: (bucket) => ({
      upload: async (path, bytes) => {
        objects.set(`${bucket}/${path}`, bytes);
        return { data: { path } };
      },
      download: async (path) => ({
        data: new Blob([
          objects.get(`${bucket}/${path}`) || Buffer.from("missing"),
        ]),
      }),
      remove: async (paths) => {
        paths.forEach((path) => objects.delete(`${bucket}/${path}`));
        return {};
      },
      createSignedUrl: async () => ({
        data: {
          signedUrl:
            "https://synthetic.supabase.co/storage/v1/object/sign/test?token=synthetic",
        },
      }),
    }),
  },
};
vi.mock("../../src/config/privateStorage.js", async (importOriginal) => ({
  ...(await importOriginal()),
  privateStorageClient: () => storage,
}));
const { app } = await import("../../src/app.js");
const S = await import("../../src/modules/riders/riders.service.js");
const W = await import("../../src/modules/riders/riders.worker.js");
const { PRIVATE_BUCKETS } = await import("../../src/config/privateStorage.js");
const delivery = await import("../../src/modules/delivery/delivery.service.js");
let actor, stranger;
const facts = {
  fullName: "Synthetic Rider",
  phone: "+2347000000000",
  state: "Lagos",
  city: "Ikeja",
  vehicleType: "MOTORCYCLE",
  licenceExpiresAt: "2099-01-01",
  insuranceExpiresAt: "2099-01-01",
  consent: true,
  consentVersion: "sabi-rider-onboarding-v1",
};
const makeUser = () =>
  prisma.user.create({
    data: {
      patientId: randomUUID(),
      email: `${randomUUID()}@rider.test`,
      password: "synthetic-only",
      accountStatus: "ACTIVE",
      emailVerifiedAt: new Date(),
    },
  });
async function application() {
  const user = await makeUser();
  const result = await S.createApplication(user.id, facts);
  return { user, id: result.id };
}
async function documents(test) {
  for (const kind of ["drivingLicence", "vehicleRegistration", "insurance"])
    await S.upload(
      test.user.id,
      test.id,
      kind,
      Buffer.from("%PDF-synthetic-no-real-data"),
      "application/pdf",
    );
}
async function submitted() {
  const test = await application();
  await documents(test);
  await S.submit(test.user.id, test.id, (await S.me(test.user.id)).version);
  return test;
}
async function clean(test) {
  await prisma.riderCredential.updateMany({
    where: { applicationId: test.id },
    data: {
      scanStatus: "CLEAN",
      storageBucket: PRIVATE_BUCKETS.hospitalEvidenceClean,
      scannerVersion: "synthetic-scanner",
      scannedAt: new Date(),
    },
  });
}
async function approved() {
  const test = await submitted();
  await clean(test);
  for (const doc of (await S.me(test.user.id)).credentials) {
    await S.review(actor.id, test.id, doc.id, {
      version: (await S.me(test.user.id)).version,
      reviewStatus: "VERIFIED",
      sourceName: "Synthetic authority",
      reference: "TEST-ONLY",
      note: "Synthetic decision for local automated test",
    });
  }
  await S.decide(actor.id, test.id, "APPROVED", {
    version: (await S.me(test.user.id)).version,
  });
  return test;
}
beforeAll(async () => {
  process.env.SUPABASE_URL = "https://synthetic.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-not-a-secret";
  process.env.EVIDENCE_SCANNER_PROVIDER = "cloudmersive";
  process.env.CLOUDMERSIVE_API_KEY = "synthetic-not-a-secret";
  process.env.RIDER_REGISTRATION_ENABLED = "true";
  process.env.EVIDENCE_SCANNER_ENABLED = "true";
  process.env.CLOUDMERSIVE_CREDENTIAL_PROCESSING_APPROVED = "true";
  actor = await makeUser();
  stranger = await makeUser();
});
describe("real PostgreSQL rider onboarding, with fake storage and email only", () => {
  it('renewal pauses active access and remains editable for reapproval',async()=>{
    const test=await approved();
    await S.updateDetails(test.user.id,test.id,{...facts,version:(await S.me(test.user.id)).version});
    expect((await S.me(test.user.id)).status).toBe('DRAFT');
    expect((await S.me(test.user.id)).credentials.every(doc=>doc.reviewStatus==='PENDING')).toBe(true);
    await expect(delivery.me(test.user.id)).rejects.toMatchObject({code:'FORBIDDEN'});
    await S.submit(test.user.id,test.id,(await S.me(test.user.id)).version);
    expect((await S.me(test.user.id)).status).toBe('SUBMITTED');
  });
  it('integrity mismatches stop before scanning and cannot be manually requeued',async()=>{
    const test=await submitted();const doc=await prisma.riderCredential.findFirst({where:{applicationId:test.id}});
    objects.set(`${doc.storageBucket}/${doc.storageKey}`,Buffer.from('%PDF-tampered'));
    const scan=vi.fn();const db={...prisma,riderCredential:{...prisma.riderCredential,findMany:async()=>[{...doc,application:{userId:test.user.id}}]}};
    await W.processRiderCredentialJob({db,client:storage,scan});
    expect(scan).not.toHaveBeenCalled();expect((await prisma.riderCredential.findUnique({where:{id:doc.id}})).scanStatus).toBe('FAILED');
    await expect(S.retryScan(actor.id,test.id,doc.id,(await S.me(test.user.id)).version)).rejects.toMatchObject({status:409});
  });
  it('provider outages remain pending with backoff rather than being called clean',async()=>{
    const test=await submitted();const doc=await prisma.riderCredential.findFirst({where:{applicationId:test.id}});
    const db={...prisma,riderCredential:{...prisma.riderCredential,findMany:async()=>[{...doc,application:{userId:test.user.id}}]}};
    await W.processRiderCredentialJob({db,client:storage,scan:async()=>{throw new Error('CLOUDMERSIVE_UNAVAILABLE');}});
    const saved=await prisma.riderCredential.findUnique({where:{id:doc.id}});
    expect(saved.scanStatus).toBe('PENDING');expect(saved.scanAttempts).toBe(1);expect(saved.scanLeaseExpiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(S.preview(actor.id,test.id,doc.id)).rejects.toMatchObject({status:409});
  });
  it("applies migration and creates a pending account with no delivery role or partner", async () => {
    const emailAddress = `${randomUUID()}@rider.test`;
    const result = await S.register({
      ...facts,
      email: emailAddress,
      password: "SyntheticOnly123!",
    });
    const user = await prisma.user.findUnique({
      where: { email: emailAddress },
      include: { roles: true, deliveryPartner: true },
    });
    expect(user.accountStatus).toBe("PENDING");
    expect(user.roles).toEqual([]);
    expect(user.deliveryPartner).toBeNull();
    expect(user.password).not.toContain("SyntheticOnly");
    expect(result.emailSent).toBe(true);
    const url = new URL(email.send.mock.calls.at(-1)[0].verificationUrl);
    expect(url.pathname).toBe(`/rider/verify-email/${user.id}`);
    expect(url.search).toBe("");
    await S.verify({ uid: user.id, token: url.hash.slice(1) });
    expect(
      (await prisma.user.findUnique({ where: { id: user.id } })).accountStatus,
    ).toBe("ACTIVE");
    await expect(
      S.verify({ uid: user.id, token: url.hash.slice(1) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      S.register({
        ...facts,
        email: emailAddress,
        password: "SyntheticOnly123!",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("public registration rejects role injection and unauthenticated own reads", async () => {
    const response = await request(app)
      .post("/api/v1/riders/register")
      .send({
        ...facts,
        email: "fake@rider.test",
        password: "SyntheticOnly123!",
        roles: ["DELIVERY_PARTNER"],
      });
    expect(response.status).toBe(400);
    expect((await request(app).get("/api/v1/riders/me")).status).toBe(401);
  });
  it("rejects expired details and unknown document kinds", async () => {
    const response = await request(app)
      .post("/api/v1/riders/register")
      .send({
        ...facts,
        email: "fake@rider.test",
        password: "SyntheticOnly123!",
        licenceExpiresAt: "2000-01-01",
      });
    expect(response.status).toBe(400);
    const test = await application();
    await expect(
      S.upload(
        test.user.id,
        test.id,
        "patientRecord",
        Buffer.from("%PDF-test"),
        "application/pdf",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
  it("enforces account isolation and denies nonplatform reviewer HTTP access", async () => {
    const test = await application();
    await expect(
      S.upload(
        stranger.id,
        test.id,
        "insurance",
        Buffer.from("%PDF-test"),
        "application/pdf",
      ),
    ).rejects.toMatchObject({ status: 404 });
    const response = await request(app)
      .get(`/api/v1/platform/riders/${test.id}`)
      .set("Authorization", tokenFor(stranger.id));
    expect(response.status).toBe(403);
  });
  it("requires all documents, checks real MIME signatures, and projects no storage secrets", async () => {
    const test = await application();
    await expect(S.submit(test.user.id, test.id, 1)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      S.upload(
        test.user.id,
        test.id,
        "insurance",
        Buffer.from("not a pdf"),
        "application/pdf",
      ),
    ).rejects.toMatchObject({ code: "PRIVATE_STORAGE_UPLOAD_INVALID" });
    await documents(test);
    const me = await S.me(test.user.id);
    expect(me.credentials).toHaveLength(3);
    expect(me.credentials.every((d) => d.scanStatus === "PENDING")).toBe(true);
    expect(JSON.stringify(me)).not.toMatch(
      /storageKey|storageBucket|sha256|scanLeaseToken/,
    );
  });
  it("queues submission confirmation without waiting for security scans and blocks approval", async () => {
    const test = await submitted();
    const me = await S.me(test.user.id);
    expect(me.status).toBe("SUBMITTED");
    expect(
      await prisma.riderMailJob.count({
        where: { applicationId: test.id, kind: "SUBMITTED" },
      }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: test.user.id } }),
    ).toBe(1);
    await S.submit(test.user.id, test.id, me.version);
    expect(
      await prisma.riderMailJob.count({ where: { applicationId: test.id } }),
    ).toBe(1);
    await expect(
      S.decide(actor.id, test.id, "APPROVED", { version: me.version }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("worker verifies hashes, scans, releases clean bytes, and never implicitly verifies authenticity", async () => {
    const test = await application();
    await S.upload(
      test.user.id,
      test.id,
      "insurance",
      Buffer.from("%PDF-scan-test"),
      "application/pdf",
    );
    const doc = await prisma.riderCredential.findFirst({
      where: { applicationId: test.id },
    });
    const scan = vi
      .fn()
      .mockResolvedValue({ verdict: "CLEAN", scannerVersion: "synthetic" });
    const db = {
      ...prisma,
      riderCredential: {
        ...prisma.riderCredential,
        findMany: async () => [
          { ...doc, application: { userId: test.user.id } },
        ],
      },
    };
    await W.processRiderCredentialJob({ db, client: storage, scan });
    const saved = await prisma.riderCredential.findUnique({
      where: { id: doc.id },
    });
    expect(saved.scanStatus).toBe("CLEAN");
    expect(saved.reviewStatus).toBe("PENDING");
    expect(saved.storageBucket).toBe(PRIVATE_BUCKETS.hospitalEvidenceClean);
    expect(objects.has(`${doc.storageBucket}/${doc.storageKey}`)).toBe(false);
  });
  it("infected documents never receive a preview", async () => {
    const test = await submitted();
    const doc = await prisma.riderCredential.findFirst({
      where: { applicationId: test.id },
    });
    await prisma.riderCredential.update({
      where: { id: doc.id },
      data: { scanStatus: "INFECTED" },
    });
    await expect(S.preview(actor.id, test.id, doc.id)).rejects.toMatchObject({
      status: 409,
    });
  });
  it("requires clean files for independent review, rejects self-review and stale versions", async () => {
    const test = await submitted();
    const doc = (await S.me(test.user.id)).credentials[0];
    const review = {
      version: (await S.me(test.user.id)).version,
      reviewStatus: "VERIFIED",
      sourceName: "Synthetic authority",
      reference: "TEST",
      note: "Synthetic review",
    };
    await expect(
      S.review(actor.id, test.id, doc.id, review),
    ).rejects.toMatchObject({ status: 409 });
    await clean(test);
    await expect(
      S.review(test.user.id, test.id, doc.id, review),
    ).rejects.toMatchObject({ status: 403 });
    await S.review(actor.id, test.id, doc.id, review);
    await expect(
      S.review(actor.id, test.id, doc.id, review),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("replacement returns to draft and superseded credential previews are denied", async () => {
    const test = await submitted();
    await clean(test);
    const old = (await S.me(test.user.id)).credentials.find(
      (d) => d.kind === "insurance",
    );
    await S.upload(
      test.user.id,
      test.id,
      "insurance",
      Buffer.from("%PDF-replacement"),
      "application/pdf",
    );
    const me = await S.me(test.user.id);
    expect(me.status).toBe("DRAFT");
    expect(me.credentials.find((d) => d.kind === "insurance").id).not.toBe(
      old.id,
    );
    await expect(S.preview(actor.id, test.id, old.id)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("approval atomically activates the partner, role, confirmation and audited access", async () => {
    const test = await approved();
    expect((await S.me(test.user.id)).status).toBe("APPROVED");
    expect(
      await prisma.userRole.count({
        where: { userId: test.user.id, role: "DELIVERY_PARTNER" },
      }),
    ).toBe(1);
    expect((await delivery.me(test.user.id)).profile.isActive).toBe(true);
    expect(
      await prisma.riderMailJob.count({
        where: { applicationId: test.id, kind: "APPROVED" },
      }),
    ).toBe(1);
    expect(
      await prisma.activityLog.count({
        where: { userId: actor.id, type: "RIDER_APPROVED" },
      }),
    ).toBeGreaterThan(0);
  });
  it("expiry blocks delivery even with an already issued role", async () => {
    const test = await approved();
    await prisma.riderApplication.update({
      where: { id: test.id },
      data: { insuranceExpiresAt: new Date("2000-01-01") },
    });
    await expect(delivery.me(test.user.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      delivery.configure(
        actor.id,
        test.user.id,
        { displayName: "Synthetic", isActive: true },
        true,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("suspension revokes delivery and cannot be bypassed by partner configuration", async () => {
    const test = await approved();
    await S.decide(actor.id, test.id, "SUSPENDED", {
      version: (await S.me(test.user.id)).version,
      reason: "Synthetic suspension",
    });
    await expect(delivery.me(test.user.id)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      delivery.configure(
        actor.id,
        test.user.id,
        { displayName: "Synthetic", isActive: true },
        true,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("durable email dispatch sends once and cancels superseded decisions", async () => {
    const test = await submitted();
    await prisma.riderMailJob.updateMany({
      where: { applicationId: { not: test.id } },
      data: { status: "CANCELLED" },
    });
    const send = vi.fn().mockResolvedValue({ sent: true, retryable: false });
    expect(
      await W.processRiderEmailJob({
        send,
        configured: () => true,
        allowed: () => true,
      }),
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await W.processRiderEmailJob({
      send,
      configured: () => true,
      allowed: () => true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    await S.decide(actor.id, test.id, "CHANGES_REQUESTED", {
      version: (await S.me(test.user.id)).version,
      reason: "Synthetic changes",
    });
    await S.updateDetails(test.user.id, test.id, {
      ...facts,
      version: (await S.me(test.user.id)).version,
    });
    await W.processRiderEmailJob({
      send,
      configured: () => true,
      allowed: () => true,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      (
        await prisma.riderMailJob.findFirst({
          where: { applicationId: test.id, kind: "CHANGES_REQUESTED" },
        })
      ).status,
    ).toBe("CANCELLED");
  });
});
