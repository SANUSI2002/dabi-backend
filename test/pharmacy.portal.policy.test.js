import { Buffer } from "node:buffer";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  commissionSnapshot,
  distanceKm,
  latestCredentials,
  pharmacyBlockers,
} from "../src/modules/pharmacies/portal.policy.js";
import { sanitizeProductImage } from "../src/modules/pharmacies/portal.service.js";

describe("pharmacy policy and product media", () => {
  it("snapshots the requested commission without adding it to the customer price", () => {
    expect(
      commissionSnapshot(
        { enabled: true, commissionBps: 1500, version: 3 },
        12345,
      ),
    ).toEqual({ commissionBps: 1500, commissionMinor: 1852, tierVersion: 3 });
    expect(() => commissionSnapshot({ enabled: false }, 100)).toThrow();
    expect(() => commissionSnapshot({ enabled: true }, -1)).toThrow();
  });
  it("computes branch delivery distance, including identical locations", () => {
    expect(
      distanceKm(
        { latitude: 6.5, longitude: 3.3 },
        { latitude: 6.5, longitude: 3.3 },
      ),
    ).toBe(0);
    expect(
      distanceKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 }),
    ).toBeCloseTo(111.195, 2);
  });
  it("does not let an old clean credential override its pending replacement", () => {
    const rows = [
      {
        id: "a",
        branchId: null,
        kind: "CAC_CERTIFICATE",
        createdAt: "2026-01-01",
        scanStatus: "CLEAN",
      },
      {
        id: "b",
        branchId: null,
        kind: "CAC_CERTIFICATE",
        createdAt: "2026-01-02",
        scanStatus: "PENDING",
      },
    ];
    expect(latestCredentials(rows)[0].id).toBe("b");
    expect(pharmacyBlockers({ credentials: rows, branches: [] })).toContain(
      "CAC_CERTIFICATE: a clean document and independent authenticity review are required.",
    );
  });
  it("decodes and re-encodes bounded images, removing source metadata", async () => {
    const input = await sharp({
      create: { width: 1200, height: 600, channels: 3, background: "#ffffff" },
    })
      .withMetadata()
      .png()
      .toBuffer();
    const result = await sanitizeProductImage(input);
    const metadata = await sharp(result).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(1000);
    expect(metadata.exif).toBeUndefined();
  });
  it("rejects SVG, malformed bytes and oversized files instead of trusting MIME labels", async () => {
    await expect(
      sanitizeProductImage(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
        ),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      sanitizeProductImage(Buffer.from("not an image")),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      sanitizeProductImage(Buffer.alloc(3 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ status: 413 });
  });
});
