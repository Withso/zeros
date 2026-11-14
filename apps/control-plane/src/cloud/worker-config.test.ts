import { generateKeyPairSync, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { workosTestEnv } from "../test-workos-env.js";
const env = {
  DATABASE_URL: "postgres://fixture@localhost/test_worker", DATABASE_MIGRATIONS_ON_BOOT: "false",
  ...workosTestEnv(), AUTH_AUDIENCE: "https://api.example.test", RAILWAY_ENVIRONMENT_NAME: "alpha",
  CLOUD_V2_ENABLED: "true", BOAT_API_KEY: "synthetic-unused-key",
  CLOUD_V2_API_URL: "https://api.example.test", CLOUD_V2_REALTIME_URL: "wss://realtime.example.test",
  CLOUD_V2_RUNTIME_SHA256: "a".repeat(64), CLOUD_V2_RUNTIME_STORE_ENDPOINT: "https://storage.example.test",
  CLOUD_V2_RUNTIME_STORE_BUCKET: "test", CLOUD_V2_RUNTIME_STORE_ACCESS_KEY_ID: "fixture", CLOUD_V2_RUNTIME_STORE_SECRET_ACCESS_KEY: "fixture",
};
it("fails closed when v2 is enabled without a valid worker signing key", () => {
  expect(() => loadConfig(env)).toThrow("CLOUD_V2_WORKER_SIGNING_KEY");
  expect(() => loadConfig({ ...env, CLOUD_V2_WORKER_SIGNING_KEY: "invalid" })).toThrow("Invalid worker signing key");
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  expect(loadConfig({ ...env, CLOUD_V2_WORKER_SIGNING_KEY: key }).cloudV2).toMatchObject({ workerSigningKey: key });
});
it("keeps prompt delivery opt-in and refuses ambiguous rollout configuration", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.promptOutbox).toBe(false);
  expect(loadConfig({ ...base, CLOUD_V2_PROMPT_OUTBOX_ENABLED: "true" }).cloudV2?.promptOutbox).toBe(true);
  expect(() => loadConfig({ ...base, CLOUD_V2_PROMPT_OUTBOX_ENABLED: "enabled" })).toThrow("CLOUD_V2_PROMPT_OUTBOX_ENABLED");
});
it("keeps new-workspace acting-user mode off until the channel explicitly enables it", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2).toMatchObject({ actingUserDefault: false });
  expect(loadConfig({ ...base, ZEROS_CLOUD_ACTING_USER_DEFAULT: "0" }).cloudV2).toMatchObject({ actingUserDefault: false });
  expect(loadConfig({ ...base, ZEROS_CLOUD_ACTING_USER_DEFAULT: "1" }).cloudV2).toMatchObject({ actingUserDefault: true });
  for (const value of ["true", "enabled", "2"]) expect(() => loadConfig({ ...base, ZEROS_CLOUD_ACTING_USER_DEFAULT: value })).toThrow("ZEROS_CLOUD_ACTING_USER_DEFAULT");
});
it("returns creates before their GitHub checks unless a deployment turns it off, and refuses ambiguous values", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.asyncCreate).toBe(true);
  expect(loadConfig({ ...base, CLOUD_V2_ASYNC_CREATE_ENABLED: " false " }).cloudV2?.asyncCreate).toBe(false);
  expect(loadConfig({ ...base, CLOUD_V2_ASYNC_CREATE_ENABLED: "TRUE" }).cloudV2?.asyncCreate).toBe(true);
  expect(() => loadConfig({ ...base, CLOUD_V2_ASYNC_CREATE_ENABLED: "0" })).toThrow("CLOUD_V2_ASYNC_CREATE_ENABLED");
});
it("keeps checkpoint retries off until a deployment enables them, and refuses ambiguous values", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.checkpointRetry).toBe(false);
  expect(loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: "true" }).cloudV2?.checkpointRetry).toBe(true);
  expect(loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: " FALSE " }).cloudV2?.checkpointRetry).toBe(false);
  expect(() => loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: "1" })).toThrow("CLOUD_V2_CHECKPOINT_RETRY_ENABLED");
});

it("uses only a dedicated public canary key on Alpha and never accepts the worker signing key for that authority", () => {
  const worker = generateKeyPairSync("ed25519"), canary = generateKeyPairSync("ed25519"), previous = generateKeyPairSync("ed25519");
  const key = worker.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const oldKey = previous.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const policy = (pair: typeof worker) => JSON.stringify({ keys: [{ id: "release", publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64") }],
    fixture: { creatorUserId: randomUUID(), organizationId: randomUUID(), repositoryId: "42" } });
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key, CLOUD_V2_WORKER_SIGNING_KEY_PREVIOUS: oldKey };
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(canary) }).cloudV2?.runtimeCanary).toBeDefined();
  for (const pair of [worker, previous]) expect(() => loadConfig({ ...base, CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(pair) })).toThrow("dedicated");
  expect(() => loadConfig({ ...base, CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY: "synthetic-private-key" })).toThrow("API must not receive");
  for (const channel of ["beta", "production"]) expect(() => loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: channel, CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(canary) })).toThrow("Alpha-only");
  expect(() => loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: "development", CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(canary) })).toThrow("Alpha-only");
});

it("uses only the release's explicit qualified support set, never the previous pin alone", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const release = (sha256: string) => ({ version: 1, sha256, sourceSha: "c".repeat(40), sourceSha256: "d".repeat(64),
    qualification: { channel: "alpha", runId: "123", runAttempt: 1, completedAt: "2026-11-01T00:00:00.000Z",
      receiptSha256: "e".repeat(64), deleted: true } });
  const current = release(env.CLOUD_V2_RUNTIME_SHA256), previous = release("b".repeat(64));
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key, CLOUD_V2_RUNTIME_RELEASE_METADATA: JSON.stringify(current),
    CLOUD_V2_RUNTIME_PREVIOUS_SHA256: previous.sha256, CLOUD_V2_RUNTIME_PREVIOUS_RELEASE_METADATA: JSON.stringify(previous) };
  expect(loadConfig(base).cloudV2?.runtime.supportedSha256).toEqual([current.sha256]);
  const support = { version: 1, currentSha256: current.sha256, releases: [current, previous] };
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_SUPPORT: JSON.stringify(support) }).cloudV2?.runtime.supportedSha256)
    .toEqual([current.sha256, previous.sha256]);
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_SUPPORT: JSON.stringify({ ...support, releases: [current] }) }).cloudV2?.runtime.supportedSha256)
    .toEqual([current.sha256]);
  for (const invalid of [
    { ...support, currentSha256: previous.sha256 }, { ...support, releases: [previous, current] },
    { ...support, releases: [current, current] }, { ...support, releases: [current, { sha256: previous.sha256 }] },
    { ...support, releases: [current, { ...previous, qualification: { ...previous.qualification, deleted: false } }] },
    { ...support, releases: [current, previous, release("f".repeat(64)), release("0".repeat(64))] },
    { ...support, token: "private-fixture-value" },
  ]) expect(() => loadConfig({ ...base, CLOUD_V2_RUNTIME_SUPPORT: JSON.stringify(invalid) })).toThrow("Invalid environment: CLOUD_V2_RUNTIME_SUPPORT");
  expect(() => loadConfig({ ...base, CLOUD_V2_RUNTIME_RELEASE_METADATA: "", CLOUD_V2_RUNTIME_SUPPORT: JSON.stringify(support) }))
    .toThrow("Invalid environment: CLOUD_V2_RUNTIME_SUPPORT");
});
