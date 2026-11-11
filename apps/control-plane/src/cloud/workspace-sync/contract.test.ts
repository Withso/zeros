import { beforeAll, expect, it } from "vitest";
import { SYNC_FEATURE, SYNC_HEADER, SYNC_WANTED_HEADER, SyncFlagSchema, SyncGrantReplySchema, SyncWantedFlagSchema,
  DeviceSyncConnectionSchema, DeviceSyncConnectionsReplySchema } from "./contract.js";

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
  expect(SYNC_WANTED_HEADER).toBe("x-zeros-sync-wanted");
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

it("accepts opted-in desired state or self-report, requiring at least one boolean and no unknown fields", () => {
  for (const value of [{ syncing: false }, { wanted: true }, { syncing: true, wanted: false }])
    expect(SyncWantedFlagSchema.parse(value)).toEqual(value);
  for (const value of [{}, { wanted: 1 }, { syncing: null, wanted: true }, { wanted: false, path: "/private" }, null])
    expect(SyncWantedFlagSchema.safeParse(value).success).toBe(false);
});

it("mirrors the device discovery bounds, optional self-report and forward-compatible replies", () => {
  const row = { workspaceId: "11111111-1111-4111-8111-111111111111", repository: "example/project", number: 1,
    name: "Workspace", syncWanted: false };
  const examples: Array<[unknown, boolean]> = [
    [row, true], [{ ...row, number: null, syncing: true }, true], [{ ...row, name: "x".repeat(120) }, true],
    [{ ...row, repository: `${"a".repeat(100)}/${"b".repeat(100)}` }, true], [{ ...row, future: true }, true],
    ...[0, -1, 1.5, "1", undefined].map(number => [{ ...row, number }, false] as [unknown, boolean]),
    ...["repo", "https://example/project", "a/b/c", "a/ b", `${"a".repeat(101)}/${"b".repeat(100)}`]
      .map(repository => [{ ...row, repository }, false] as [unknown, boolean]),
    ...["", "x".repeat(121)].map(name => [{ ...row, name }, false] as [unknown, boolean]),
    [{ ...row, workspaceId: "wrong" }, false], [{ ...row, syncWanted: undefined }, false],
    [{ ...row, syncWanted: 1 }, false], [{ ...row, syncing: null }, false],
  ];
  for (const [value, valid] of examples) {
    const local = DeviceSyncConnectionSchema.safeParse(value), shared = protocol.DeviceSyncConnectionSchema.safeParse(value);
    expect(local.success).toBe(valid); expect(shared.success).toBe(valid);
    if (valid) expect(local.data).toEqual(shared.data);
  }
  for (const [value, valid] of [
    [{ connections: [], nextCursor: null }, true], [{ connections: Array(200).fill(row), nextCursor: row.workspaceId }, true],
    [{ connections: [row], nextCursor: null, future: "allowed" }, true],
    [{ connections: Array(201).fill(row), nextCursor: null }, false], [{ connections: [], nextCursor: "wrong" }, false],
    [{ connections: [] }, false],
  ] as Array<[unknown, boolean]>) {
    const local = DeviceSyncConnectionsReplySchema.safeParse(value), shared = protocol.DeviceSyncConnectionsReplySchema.safeParse(value);
    expect(local.success).toBe(valid); expect(shared.success).toBe(valid);
    if (valid) expect(local.data).toEqual(shared.data);
  }
});
