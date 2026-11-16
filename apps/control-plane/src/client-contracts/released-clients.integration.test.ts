// Replays the requests each kept desktop release and cloud worker runtime sends
// and checks every reply with that release's own parser. A backend change that
// breaks an app still in its support window, or the previous runtime during a
// pin handover, fails here, before Production. *-next.json describe main;
// released/<client>-X.Y.Z.json are shipped releases, copied from their tags with
// `pnpm client-contract:release X.Y.Z`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "../cloud/execution/test-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const response = z.record(z.string(), z.unknown());
const DesktopContract = z.object({
  version: z.literal(1),
  client: z.literal("desktop"),
  entries: z.array(z.object({
    id: z.string().min(1),
    method: z.literal("GET"),
    path: z.string().startsWith("/v1/"),
    headers: z.record(z.string(), z.string()),
    response,
  })).min(1),
});
const WorkerContract = z.object({
  version: z.literal(1),
  client: z.literal("worker"),
  headers: z.object({ "X-Zeros-Worker-Features": z.string() }),
  entries: z.array(z.object({
    id: z.string().min(1),
    method: z.enum(["GET", "POST"]),
    path: z.string().regex(/^[a-z0-9/-]+$/),
    body: z.record(z.string(), z.unknown()).optional(),
    response,
  })).min(1),
});
const CLIENTS = { desktop: DesktopContract, worker: WorkerContract } as const;

function clientContracts<C extends keyof typeof CLIENTS>(client: C, dir = here): { name: string; contract: z.infer<(typeof CLIENTS)[C]> }[] {
  const pattern = new RegExp(`^${client}-[0-9]+\\.[0-9]+\\.[0-9]+\\.json$`);
  const released = readdirSync(path.join(dir, "released")).filter(name => pattern.test(name)).sort();
  return [path.join(dir, `${client}-next.json`), ...released.map(name => path.join(dir, "released", name))]
    .map(file => ({ name: path.basename(file, ".json"), contract: CLIENTS[client].parse(JSON.parse(readFileSync(file, "utf8"))) as z.infer<(typeof CLIENTS)[C]> }));
}

/** Fill {name} placeholders, refusing any the fixture cannot supply. */
function fill<T>(value: T, values: Record<string, string>, id: string, encode = (text: string) => text): T {
  return JSON.parse(JSON.stringify(value).replace(/\{([A-Za-z0-9]+)\}/g, (_match, key: string) => {
    const filled = values[key];
    if (!filled) throw new Error(`${id}: unknown placeholder {${key}}`);
    return encode(filled);
  })) as T;
}

const rejected = (schema: Record<string, unknown>, body: unknown) => {
  const parsed = z.fromJSONSchema(schema as never).safeParse(body);
  return parsed.success ? [] : parsed.error.issues;
};

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe("kept client contracts", () => {
  it.each(["desktop", "worker"] as const)("parse, and keep at most %s on main plus two releases", client => {
    const contracts = clientContracts(client);
    expect(contracts[0]!.name).toBe(`${client}-next`);
    expect(contracts.length).toBeLessThanOrEqual(3);
  });

  it("round-trip the checks that catch real breaks", () => {
    // The app writes JSON Schema with z.toJSONSchema; this side reads it back.
    const old = z.fromJSONSchema(z.toJSONSchema(z.object({ state: z.enum(["running", "stopped"]), name: z.string() }), { io: "input" }) as never);
    expect(old.safeParse({ state: "running", name: "w", added: 1 }).success).toBe(true);
    expect(old.safeParse({ state: "hibernating", name: "w" }).success).toBe(false);
    expect(old.safeParse({ state: "running" }).success).toBe(false);
    expect(old.safeParse({ state: "running", name: null }).success).toBe(false);
  });
});

for (const { name, contract } of clientContracts("desktop")) {
  database(`${name} still works against this control plane`, () => {
    let pool: pg.Pool, f: ExecutionFixture;
    beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
    beforeEach(async () => { f = await executionFixture(pool); });
    afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    afterAll(() => pool.end());

    it.each(contract.entries.map(entry => [entry.id, entry] as const))("%s", async (_id, entry) => {
      const values = { organizationId: f.organizationId, workspaceId: f.workspace.id, chatId: "contract-chat" };
      const response = await f.call(fill(entry.path, values, entry.id, encodeURIComponent), entry.method, undefined, f.creator, entry.headers);
      const body: unknown = await response.json().catch(() => null);
      expect(response.status, `${entry.id} answered ${JSON.stringify(body)}`).toBeLessThan(300);
      expect(rejected(entry.response, body), `${name} would reject ${entry.id}`).toEqual([]);
    });
  });
}

for (const { name, contract } of clientContracts("worker")) {
  database(`${name} still boots against this control plane`, () => {
    let pool: pg.Pool, f: ExecutionFixture;
    beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
    beforeEach(async () => { f = await executionFixture(pool); });
    afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    afterAll(() => pool.end());

    // One boot, in order: config and activity need the boot hello registered.
    it(contract.entries.map(entry => entry.id).join(" → "), async () => {
      const values = { runtimeSha256: "b".repeat(64), bootId: f.boot };
      for (const entry of contract.entries) {
        const response = await f.worker(entry.path, entry.body === undefined ? undefined : fill(entry.body, values, entry.id),
          { method: entry.method, features: contract.headers["X-Zeros-Worker-Features"] });
        const body: unknown = await response.json().catch(() => null);
        expect(response.status, `${entry.id} answered ${JSON.stringify(body)}`).toBeLessThan(300);
        expect(rejected(entry.response, body), `${name} would reject ${entry.id}`).toEqual([]);
      }
    });
  });
}
