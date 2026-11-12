import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { S3Client } from "@aws-sdk/client-s3";
import { activeRuntimeQualification, readRuntimeCapabilities, runtimeCapabilitiesKey } from "./runtime-capabilities.js";
import * as storage from "./runtime-source.js";
import type { RuntimeCanaryAdmission } from "./runtime-canary.js";

const store = { endpoint: "https://storage.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" };
const record = { version: 1, sha256: "a".repeat(64), sourceSha256: "b".repeat(64), commit: "c".repeat(40), features: ["acting-user-v1", "sync-context-v1"] };
const release = { version: 1 as const, sha256: record.sha256, sourceSha256: record.sourceSha256, sourceSha: record.commit,
  qualification: { channel: "alpha" as const, runId: "123", runAttempt: 1, completedAt: "2026-01-01T00:00:00Z", receiptSha256: "d".repeat(64), deleted: true as const } };
const missing = { $metadata: { httpStatusCode: 404 } };
afterEach(() => vi.restoreAllMocks());
function client(value: unknown = record, error?: unknown, headError?: unknown) {
  return { send: vi.fn(async command => {
    if (command.constructor.name === "HeadObjectCommand") { if (headError) throw headError; return { ContentLength: 123 }; }
    if (error) throw error;
    return { Body: Readable.from([Buffer.from(JSON.stringify(value))]) };
  }), destroy: vi.fn() } as unknown as S3Client;
}

it("binds a capability record to the exact archive and requires the archive to exist", async () => {
  const c = client();
  expect(await readRuntimeCapabilities(record.sha256, store, c)).toEqual(record);
  expect(vi.mocked(c.send).mock.calls.map(([command]) => command.input)).toEqual([
    { Bucket: "fixture", Key: runtimeCapabilitiesKey(record.sha256) },
    { Bucket: "fixture", Key: `cloud-v2/runtime/${record.sha256}.tar.gz` },
  ]);
  expect(await readRuntimeCapabilities(record.sha256, store, client(record, missing))).toBeNull();
  expect(await readRuntimeCapabilities(record.sha256, store, client(record, undefined, missing))).toBeNull();
  await expect(readRuntimeCapabilities(record.sha256, store, client({ ...record, sha256: "e".repeat(64) }))).rejects.toMatchObject({ status: 503 });
  await expect(readRuntimeCapabilities(record.sha256, store, client(record, new Error("offline")))).rejects.toMatchObject({ status: 503 });
});

it.each([[], ["acting-user-v1"], ["sync-context-v1"]].map(features => [features]))("never falls back to legacy for a missing capability: %j", async features => {
  vi.spyOn(storage, "runtimeStorageClient").mockReturnValue(client({ ...record, features }));
  await expect(activeRuntimeQualification("development", { ...record, store })()).rejects.toMatchObject({ code: features.length ? "worker_update_required" : "worker_runtime_unavailable" });
});

it("requires the completed release to name the exact archive and source on hosted channels", async () => {
  vi.spyOn(storage, "runtimeStorageClient").mockImplementation(() => client());
  for (const channel of ["alpha", "beta", "production", undefined]) {
    await expect(activeRuntimeQualification(channel, { ...record, store })()).rejects.toMatchObject({ code: "worker_update_required" });
    for (const wrong of [{ sha256: "e".repeat(64) }, { sourceSha: "e".repeat(40) }, { sourceSha256: "e".repeat(64) }])
      await expect(activeRuntimeQualification(channel, { ...record, store, release: { ...release, ...wrong } })()).rejects.toMatchObject({ code: "worker_update_required" });
    expect(await activeRuntimeQualification(channel, { ...record, store, release })()).toEqual(record);
  }
  expect(await activeRuntimeQualification("development", { ...record, store })()).toEqual(record);
});

it("lets only a verified Alpha canary's exact unexpired candidate replace the release receipt", async () => {
  vi.spyOn(storage, "runtimeStorageClient").mockImplementation(() => client());
  const grant = { runtimeSha256: record.sha256, sourceSha: record.commit, exp: Math.floor(Date.now() / 1000) + 60 } as RuntimeCanaryAdmission;
  const qualify = activeRuntimeQualification("alpha", { ...record, store });
  expect(await qualify(grant)).toEqual(record);
  for (const wrong of [{ runtimeSha256: "e".repeat(64) }, { sourceSha: "e".repeat(40) }, { exp: 1 }])
    await expect(qualify({ ...grant, ...wrong })).rejects.toMatchObject({ status: expect.any(Number) });
  for (const channel of ["development", "beta", "production"])
    await expect(activeRuntimeQualification(channel, { ...record, store })(grant)).rejects.toMatchObject({ code: "worker_update_required" });
});

it("does not cache an absent or unavailable record and coalesces a known immutable pin", async () => {
  const factory = vi.spyOn(storage, "runtimeStorageClient").mockReturnValueOnce(client(record, missing)).mockReturnValueOnce(client(record, new Error("offline"))).mockReturnValue(client());
  const qualify = activeRuntimeQualification("development", { ...record, store });
  await expect(qualify()).rejects.toMatchObject({ status: 409 });
  await expect(qualify()).rejects.toMatchObject({ status: 503 });
  expect(await Promise.all([qualify(), qualify()])).toEqual([record, record]);
  expect(factory).toHaveBeenCalledTimes(3);
});

it("qualifies the selected development pin after a repin without changing a running server's config", async () => {
  const next = { ...record, sha256: "e".repeat(64), sourceSha256: "f".repeat(64), commit: "a".repeat(40) };
  const factory = vi.spyOn(storage, "runtimeStorageClient").mockReturnValueOnce(client()).mockReturnValueOnce(client(next));
  const qualify = activeRuntimeQualification("development", { ...record, store });
  expect(await qualify()).toEqual(record);
  expect(await qualify(undefined, next.sha256)).toEqual(next);
  expect(await qualify(undefined, record.sha256)).toEqual(record);
  expect(factory).toHaveBeenCalledTimes(2);
});

it("never accepts a development pin override on a hosted channel", async () => {
  const factory = vi.spyOn(storage, "runtimeStorageClient").mockImplementation(() => client());
  for (const channel of ["alpha", "beta", "production", undefined])
    await expect(activeRuntimeQualification(channel, { ...record, store, release })(undefined, record.sha256)).rejects.toMatchObject({ code: "worker_update_required" });
  expect(factory).not.toHaveBeenCalled();
});
