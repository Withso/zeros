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
it("keeps provider-stop recovery off until a deployment opts in, and refuses ambiguous values", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.providerStopRecovery).toBe("off");
  expect(loadConfig({ ...base, CLOUD_V2_PROVIDER_STOP_RECOVERY: " Observe " }).cloudV2?.providerStopRecovery).toBe("observe");
  expect(loadConfig({ ...base, CLOUD_V2_PROVIDER_STOP_RECOVERY: "on" }).cloudV2?.providerStopRecovery).toBe("on");
  expect(() => loadConfig({ ...base, CLOUD_V2_PROVIDER_STOP_RECOVERY: "true" })).toThrow("CLOUD_V2_PROVIDER_STOP_RECOVERY");
});
it("keeps execution token verdicts out of memory until a deployment opts in, and refuses ambiguous values", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.executionAuthCache).toBe("off");
  expect(loadConfig({ ...base, CLOUD_V2_EXECUTION_AUTH_CACHE: " Shadow " }).cloudV2?.executionAuthCache).toBe("shadow");
  expect(loadConfig({ ...base, CLOUD_V2_EXECUTION_AUTH_CACHE: "on" }).cloudV2?.executionAuthCache).toBe("on");
  expect(() => loadConfig({ ...base, CLOUD_V2_EXECUTION_AUTH_CACHE: "true" })).toThrow("CLOUD_V2_EXECUTION_AUTH_CACHE");
});
it("keeps checkpoint retries off until a deployment enables them, and refuses ambiguous values", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.checkpointRetry).toBe(false);
  expect(loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: "true" }).cloudV2?.checkpointRetry).toBe(true);
  expect(loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: " FALSE " }).cloudV2?.checkpointRetry).toBe(false);
  expect(() => loadConfig({ ...base, CLOUD_V2_CHECKPOINT_RETRY_ENABLED: "1" })).toThrow("CLOUD_V2_CHECKPOINT_RETRY_ENABLED");
});

it("keeps ready copies off until a deployment enables them, and validates the shared base", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2).toMatchObject({ readyCopies: false });
  expect(loadConfig(base).cloudV2).not.toHaveProperty("sharedBaseSnapshot");
  expect(loadConfig({ ...base, CLOUD_V2_READY_COPIES_ENABLED: " TRUE ", CLOUD_V2_SHARED_BASE_SNAPSHOT: "zeros-base-1" }).cloudV2)
    .toMatchObject({ readyCopies: true, sharedBaseSnapshot: "zeros-base-1" });
  expect(() => loadConfig({ ...base, CLOUD_V2_READY_COPIES_ENABLED: "1" })).toThrow("CLOUD_V2_READY_COPIES_ENABLED");
  expect(() => loadConfig({ ...base, CLOUD_V2_SHARED_BASE_SNAPSHOT: "Not A Name" })).toThrow("CLOUD_V2_SHARED_BASE_SNAPSHOT");
});

it("reads CLOUD_V2_SHARED_BASE_SNAPSHOT as the shared base override: a name pins it, off turns it off, auto asks for the builder's", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.sharedBaseOverride).toBeNull();
  expect(loadConfig({ ...base, CLOUD_V2_SHARED_BASE_SNAPSHOT: "zeros-alpha-base-1a2b3c4d5e6f" }).cloudV2)
    .toMatchObject({ sharedBaseSnapshot: "zeros-alpha-base-1a2b3c4d5e6f", sharedBaseOverride: { kind: "name", name: "zeros-alpha-base-1a2b3c4d5e6f" } });
  const off = loadConfig({ ...base, CLOUD_V2_SHARED_BASE_SNAPSHOT: " off " }).cloudV2;
  expect(off?.sharedBaseOverride).toEqual({ kind: "off" });
  // Older readers of sharedBaseSnapshot see no shared base, never a snapshot called "off".
  expect(off).not.toHaveProperty("sharedBaseSnapshot");
  expect(() => loadConfig({ ...base, CLOUD_V2_SHARED_BASE_SNAPSHOT: "OFF" })).toThrow("CLOUD_V2_SHARED_BASE_SNAPSHOT");
  // auto: the builder's own shared base (what a Local control plane needs to build one); never a snapshot called "auto".
  const auto = loadConfig({ ...base, CLOUD_V2_SHARED_BASE_SNAPSHOT: "auto" }).cloudV2;
  expect(auto?.sharedBaseOverride).toEqual({ kind: "auto" });
  expect(auto).not.toHaveProperty("sharedBaseSnapshot");
});

it("keeps retention off until a deployment enables it", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2).toMatchObject({ retention: false });
  expect(loadConfig({ ...base, CLOUD_V2_RETENTION_ENABLED: " TRUE " }).cloudV2).toMatchObject({ retention: true });
  expect(loadConfig({ ...base, CLOUD_V2_RETENTION_ENABLED: "false" }).cloudV2).toMatchObject({ retention: false });
  expect(() => loadConfig({ ...base, CLOUD_V2_RETENTION_ENABLED: "1" })).toThrow("CLOUD_V2_RETENTION_ENABLED");
  expect(loadConfig(base).cloudV2).not.toHaveProperty("backupForksPerHour");
  expect(loadConfig({ ...base, CLOUD_V2_RETENTION_BACKUP_FORKS_PER_HOUR: "8" }).cloudV2).toMatchObject({ backupForksPerHour: 8 });
  for (const value of ["0", "201", "2.5", "many"])
    expect(() => loadConfig({ ...base, CLOUD_V2_RETENTION_BACKUP_FORKS_PER_HOUR: value })).toThrow("CLOUD_V2_RETENTION_BACKUP_FORKS_PER_HOUR");
  // S2's shared maintenance budget: the lifecycle's 20/hour and 120/day unless set.
  expect(loadConfig(base).cloudV2).not.toHaveProperty("maintenancePerHour");
  expect(loadConfig(base).cloudV2).not.toHaveProperty("maintenancePerDay");
  expect(loadConfig({ ...base, CLOUD_V2_RETENTION_MAINTENANCE_PER_HOUR: " 40 ", CLOUD_V2_RETENTION_MAINTENANCE_PER_DAY: "900" }).cloudV2)
    .toMatchObject({ maintenancePerHour: 40, maintenancePerDay: 900 });
  for (const [name, values] of [["CLOUD_V2_RETENTION_MAINTENANCE_PER_HOUR", ["0", "721", "2.5", "-1", "many"]],
    ["CLOUD_V2_RETENTION_MAINTENANCE_PER_DAY", ["0", "10000", "1e3", "many"]]] as const)
    for (const value of values) expect(() => loadConfig({ ...base, [name]: value })).toThrow(name);
  // Ready copies' automatic bases: their own budget beside maintenance, the code's 4/hour and 30/day unless set.
  expect(loadConfig(base).cloudV2).not.toHaveProperty("automaticBasePerHour");
  expect(loadConfig({ ...base, CLOUD_V2_AUTOMATIC_BASE_PER_HOUR: "6", CLOUD_V2_AUTOMATIC_BASE_PER_DAY: "48" }).cloudV2)
    .toMatchObject({ automaticBasePerHour: 6, automaticBasePerDay: 48 });
  for (const value of ["0", "721", "many"]) expect(() => loadConfig({ ...base, CLOUD_V2_AUTOMATIC_BASE_PER_HOUR: value })).toThrow("CLOUD_V2_AUTOMATIC_BASE_PER_HOUR");
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
  for (const channel of ["production"]) expect(() => loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: channel, CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(canary) })).toThrow("Alpha-only");
  expect(() => loadConfig({ ...base, RAILWAY_ENVIRONMENT_NAME: "development", CLOUD_V2_RUNTIME_CANARY_CONFIG: policy(canary) })).toThrow("Alpha-only");
});
it("reads the release's previous runtime pin only when it is a distinct published digest", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2?.runtime.previousSha256).toBeUndefined();
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_PREVIOUS_SHA256: "" }).cloudV2?.runtime.previousSha256).toBeUndefined();
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_PREVIOUS_SHA256: "b".repeat(64) }).cloudV2?.runtime.previousSha256).toBe("b".repeat(64));
  expect(loadConfig({ ...base, CLOUD_V2_RUNTIME_PREVIOUS_SHA256: "a".repeat(64) }).cloudV2?.runtime.previousSha256).toBeUndefined();
  expect(() => loadConfig({ ...base, CLOUD_V2_RUNTIME_PREVIOUS_SHA256: "previous" })).toThrow("CLOUD_V2_RUNTIME_PREVIOUS_SHA256");
});

it("keeps cloud in Personal organizations off until a deployment enables it", () => {
  const key = generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const base = { ...env, CLOUD_V2_WORKER_SIGNING_KEY: key };
  expect(loadConfig(base).cloudV2).toMatchObject({ personalCloud: false });
  expect(loadConfig({ ...base, CLOUD_V2_PERSONAL_CLOUD_ENABLED: " TRUE " }).cloudV2).toMatchObject({ personalCloud: true });
  expect(loadConfig({ ...base, CLOUD_V2_PERSONAL_CLOUD_ENABLED: "false" }).cloudV2).toMatchObject({ personalCloud: false });
  expect(() => loadConfig({ ...base, CLOUD_V2_PERSONAL_CLOUD_ENABLED: "1" })).toThrow("CLOUD_V2_PERSONAL_CLOUD_ENABLED");
});
