import { beforeAll, expect, it } from "vitest";
import { SYNC_FEATURE, SYNC_HEADER, SyncFlagSchema, SyncGrantReplySchema } from "./contract.js";

let protocol: Record<string, any>;
beforeAll(async () => {
  // The standalone CP uses an exact mirror; integration resolves the real
  // worker/desktop schema without a production package dependency.
  const root = new URL(process.env.CLOUD_API_TEST_PROTOCOL_ROOT ?? "../../../../../packages/protocol/src/", import.meta.url);
  protocol = await import(new URL("workspace-sync.ts", root).href);
});

it("matches the direct-grant feature and strict reply schema", () => {
  expect(SYNC_FEATURE).toBe(protocol.SYNC_FEATURE);
  expect(SYNC_HEADER).toBe("x-zeros-sync");
  const reply = { url: "https://route.example.test/", portAuth: "synthetic-port-credential", grant: "v1.eA.eA", expiresAt: "2026-11-11T01:00:00.000Z" };
  const cases: Array<[unknown, boolean]> = [[reply, true], [{ ...reply, extra: true }, false]];
  for (const url of ["http://route.example.test/", "wss://route.example.test/", "https://user@route.example.test/", "https://route.example.test/private",
    "https://route.example.test/?secret=fixture", "https://route.example.test/#fragment"])
    cases.push([{ ...reply, url }, false]);
  for (const portAuth of ["short", "x".repeat(8193), "x".repeat(20) + "\r\n", "x".repeat(20) + ";"])
    cases.push([{ ...reply, portAuth }, false]);
  for (const grant of ["v2.eA.eA", "v1.eA.eA\n", "v1..eA", "v1." + "x".repeat(4096) + ".eA"])
    cases.push([{ ...reply, grant }, false]);
  cases.push([{ ...reply, expiresAt: "tomorrow" }, false]);
  for (const [value, valid] of cases) {
    const local = SyncGrantReplySchema.safeParse(value), shared = protocol.SyncGrantReplySchema.safeParse(value);
    expect(local.success).toBe(valid); expect(shared.success).toBe(valid);
    if (valid) expect(local.data).toEqual(shared.data);
  }
});

it("accepts only a boolean sync flag", () => {
  for (const syncing of [true, false]) expect(SyncFlagSchema.parse({ syncing })).toEqual({ syncing });
  for (const value of [{}, { syncing: 1 }, { syncing: true, path: "/private" }, null]) expect(SyncFlagSchema.safeParse(value).success).toBe(false);
});
