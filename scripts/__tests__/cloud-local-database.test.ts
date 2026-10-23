import { describe, expect, it } from "vitest";
import { validateDatabaseRequest } from "../dev-environment/database.mjs";
import { databaseUrl } from "../dev-environment/postgres.mjs";

const owner = "a".repeat(24), instanceId = "11111111-1111-4111-8111-111111111111";
const workspace = { state: { database: { name: `zeros_dev_${owner}`, migrationPassword: "b".repeat(64), runtimePassword: "c".repeat(64) } } };
const request = { owner, instanceId, port: 23000,
  migrationUrl: databaseUrl(workspace, 23000, "migration"), runtimeUrl: databaseUrl(workspace, 23000) };

describe("electron:cloud database actions", () => {
  it("allows seed only against the exact owned loopback database", () => {
    expect(validateDatabaseRequest({ ...request, action: "seed" }).action).toBe("seed");
    for (const change of [
      { runtimeUrl: request.runtimeUrl.replace("127.0.0.1", "alpha.pg.psdb.cloud") },
      { migrationUrl: request.migrationUrl.replace(owner, "d".repeat(24)) },
      { instanceId: undefined }, { instanceId: "other" },
    ]) expect(() => validateDatabaseRequest({ ...request, action: "seed", ...change })).toThrow();
  });

  it("requires a stopped backend and an instance receipt before draining Boat resources", () => {
    expect(validateDatabaseRequest({ ...request, action: "drain", backendStopped: true }).action).toBe("drain");
    for (const change of [{ backendStopped: false }, { backendStopped: undefined }, { instanceId: undefined }])
      expect(() => validateDatabaseRequest({ ...request, action: "drain", backendStopped: true, ...change })).toThrow();
  });
});
