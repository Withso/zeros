import { describe, expect, it, vi } from "vitest";
import { localDevelopmentIdentity, hostedDevelopmentIdentity, assertHostedDatabaseOwnership } from "./development-environment.js";
import { railwayEnvironmentName } from "../../../scripts/dev-environment/railway.mjs";

const owner = "a".repeat(24), runId = "fb87f8dd-6161-463b-981c-d039c675e0ca";
const env = { ZEROS_DEV_ENVIRONMENT: "local", ZEROS_DEV_OWNER: owner, ZEROS_DEV_RUN_ID: runId,
  ZEROS_DEV_DOMAIN: "example.test", HOST: "127.0.0.1", DATABASE_MIGRATIONS_ON_BOOT: "false",
  DATABASE_URL: `postgresql://zeros_dev_runtime:synthetic@127.0.0.1:23456/zeros_dev_${owner}`,
  AUTH_PROVIDER: "workos", AUTH_AUDIENCE: "https://api-dev.example.test", APP_ORIGIN: `https://app-dev-${owner}.example.test` };
describe("local development control-plane identity", () => {
  it("keeps release configuration unchanged and accepts only the local contract", () => {
    expect(localDevelopmentIdentity({})).toBeUndefined();
    expect(localDevelopmentIdentity(env)).toEqual({ owner, runId });
  });
  it("requires explicit Alpha identity sharing without accepting the Alpha database or app origin", () => {
    const alpha = { ...env, ZEROS_DEV_AUTH_ENVIRONMENT: "alpha", AUTH_AUDIENCE: "https://api-alpha.zeros.build" };
    expect(localDevelopmentIdentity(alpha)).toEqual({ owner, runId });
    expect(() => localDevelopmentIdentity({ ...alpha, ZEROS_DEV_AUTH_ENVIRONMENT: undefined })).toThrow();
    expect(() => localDevelopmentIdentity({ ...alpha, APP_ORIGIN: "https://app-alpha.zeros.build" })).toThrow();
    expect(() => localDevelopmentIdentity({ ...alpha, AUTH_AUDIENCE: "https://api.zeros.build" })).toThrow();
  });
  it.each([
    { RAILWAY_PROJECT_ID: "release-project" }, { HOST: "0.0.0.0" }, { ZEROS_SELF_HOSTED: "true" },
    { DATABASE_MIGRATIONS_ON_BOOT: "true" }, { DATABASE_MIGRATION_URL: env.DATABASE_URL },
    { DATABASE_URL: env.DATABASE_URL.replace("127.0.0.1", "hosted.example.test") },
    { DATABASE_URL: env.DATABASE_URL.replace("zeros_dev_runtime", "postgres") },
    { DATABASE_URL: env.DATABASE_URL + "?options=-crole=postgres" },
    { DATABASE_LISTEN_URL: env.DATABASE_URL.replace("23456", "23457") },
    { APP_ORIGIN: "https://app-alpha.zeros.build" }, { AUTH_AUDIENCE: "https://api.zeros.build" },
  ])("rejects cross-environment or elevated configuration %#", override => {
    expect(() => localDevelopmentIdentity({ ...env, ...override })).toThrow();
  });
});

describe("hosted development control-plane identity", () => {
  const build = { sourceSha256: "b".repeat(64), workerInputsSha256: "c".repeat(64) };
  const generation = "11111111-1111-4111-8111-111111111111";
  const database = new URL("postgresql://aws-us-west-2-1.pg.psdb.cloud:5432/postgres?sslmode=verify-full");
  database.username = "pscale_api_runtime.examplebranch"; database.password = "synthetic-test-password";
  const hosted = { ...env, ZEROS_DEV_ENVIRONMENT: "hosted", HOST: "0.0.0.0",
    ZEROS_DEV_GENERATION: generation, RAILWAY_PROJECT_ID: generation, ZEROS_DEV_RAILWAY_PROJECT_ID: generation,
    RAILWAY_ENVIRONMENT_ID: runId, ZEROS_DEV_RAILWAY_ENVIRONMENT_ID: runId,
    RAILWAY_ENVIRONMENT_NAME: `dev-${owner}-${generation.replaceAll("-", "")}`,
    ZEROS_DEV_SOURCE_SHA256: build.sourceSha256, ZEROS_DEV_WORKER_INPUTS_SHA256: build.workerInputsSha256,
    INVITE_LINK_BASE: `${env.APP_ORIGIN}/invite`, ZEROS_DEV_DATABASE_HOST: "aws-us-west-2-1.pg.psdb.cloud",
    ZEROS_DEV_DATABASE_USER: "pscale_api_runtime.examplebranch",
    DATABASE_URL: database.toString() };
  it("accepts only the actual built candidate and explicit Dev environment", () => {
    expect(hostedDevelopmentIdentity(hosted, build)).toEqual({ owner, runId, generation, ...build });
    expect(() => hostedDevelopmentIdentity(hosted, null)).toThrow(/source artifact/);
  });
  it("accepts the launcher's compact Railway name while retaining exact generation validation", () => {
    const name = railwayEnvironmentName({ owner, generation });
    expect(hostedDevelopmentIdentity({ ...hosted, RAILWAY_ENVIRONMENT_NAME: name }, build)).toEqual({ owner, runId, generation, ...build });
    for (const wrong of [railwayEnvironmentName({ owner, generation: runId }), railwayEnvironmentName({ owner: "d".repeat(24), generation })]) {
      expect(() => hostedDevelopmentIdentity({ ...hosted, RAILWAY_ENVIRONMENT_NAME: wrong }, build)).toThrow(/identity/);
    }
  });
  it("requires the database's own generation marker and unprivileged login at startup", async () => {
    const identity = hostedDevelopmentIdentity(hosted, build);
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ owner, generation: runId }] });
    await expect(assertHostedDatabaseOwnership({ query } as never, identity)).rejects.toThrow(/ownership/);
    expect(query).toHaveBeenCalledTimes(1);
    query.mockResolvedValueOnce({ rows: [{ owner, generation }] }).mockResolvedValueOnce({ rows: [{ rolsuper: false, admin: true }] });
    await expect(assertHostedDatabaseOwnership({ query } as never, identity)).rejects.toThrow(/privileges/);
    query.mockResolvedValueOnce({ rows: [{ owner, generation }] }).mockResolvedValueOnce({ rows: [{ rolsuper: false, admin: false, ddl: false }] });
    await expect(assertHostedDatabaseOwnership({ query } as never, identity)).resolves.toBeUndefined();
  });
  it.each([
    { RAILWAY_ENVIRONMENT_NAME: "alpha" }, { RAILWAY_ENVIRONMENT_NAME: "production" },
    { ZEROS_DEV_SOURCE_SHA256: "d".repeat(64) }, { DATABASE_MIGRATIONS_ON_BOOT: "true" },
    { DATABASE_MIGRATION_ROLE: "postgres" }, { ZEROS_SELF_HOSTED: "true" },
    { DATABASE_URL: hosted.DATABASE_URL.replace("examplebranch", "alphabranch") },
    { DATABASE_URL: hosted.DATABASE_URL.replace("5432", "6432") },
    { DATABASE_URL: hosted.DATABASE_URL.replace("verify-full", "require") },
    { APP_ORIGIN: "https://app-alpha.zeros.build" }, { RAILWAY_ENVIRONMENT_ID: generation },
  ])("rejects release or stale candidate configuration %#", override => {
    expect(() => hostedDevelopmentIdentity({ ...hosted, ...override }, build)).toThrow();
  });
});
