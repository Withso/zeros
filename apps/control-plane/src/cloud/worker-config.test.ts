import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import { loadConfig } from "../config.js";
const env = {
  DATABASE_URL: "postgres://fixture@localhost/test_worker", DATABASE_MIGRATIONS_ON_BOOT: "false",
  AUTH0_DOMAIN: "identity.example.test", AUTH_AUDIENCE: "https://api.example.test", RAILWAY_ENVIRONMENT_NAME: "alpha",
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
