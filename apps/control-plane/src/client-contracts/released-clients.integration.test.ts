// Replays the requests each kept desktop release sends and checks every reply
// with that release's own parser. A backend change that breaks an app still in
// its support window fails here, before Production. desktop-next.json is the app
// on main; released/desktop-X.Y.Z.json are shipped apps, copied from their tags
// with `pnpm client-contract:release X.Y.Z`.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { z } from "zod";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { executionFixture, type ExecutionFixture } from "../cloud/execution/test-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const Contract = z.object({
  version: z.literal(1),
  client: z.literal("desktop"),
  entries: z.array(z.object({
    id: z.string().min(1),
    method: z.literal("GET"),
    path: z.string().startsWith("/v1/"),
    headers: z.record(z.string(), z.string()),
    response: z.record(z.string(), z.unknown()),
  })).min(1),
});

function clientContracts(dir = here) {
  const released = readdirSync(path.join(dir, "released")).filter(name => /^desktop-[0-9]+\.[0-9]+\.[0-9]+\.json$/.test(name)).sort();
  return [path.join(dir, "desktop-next.json"), ...released.map(name => path.join(dir, "released", name))]
    .map(file => ({ name: path.basename(file, ".json"), contract: Contract.parse(JSON.parse(readFileSync(file, "utf8"))) }));
}

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describe("kept desktop client contracts", () => {
  it("parse, and keep at most the app on main plus two releases", () => {
    const contracts = clientContracts();
    expect(contracts[0]!.name).toBe("desktop-next");
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

for (const { name, contract } of clientContracts()) {
  database(`${name} still works against this control plane`, () => {
    let pool: pg.Pool, f: ExecutionFixture;
    beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, statement_timeout: 5000 }); });
    beforeEach(async () => { f = await executionFixture(pool); });
    afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
    afterAll(() => pool.end());

    it.each(contract.entries.map(entry => [entry.id, entry] as const))("%s", async (_id, entry) => {
      const values: Record<string, string> = { organizationId: f.organizationId, workspaceId: f.workspace.id, chatId: "contract-chat" };
      const target = entry.path.replace(/\{([^}]+)\}/g, (_match, key: string) => {
        const value = values[key];
        if (!value) throw new Error(`${entry.id}: unknown placeholder {${key}}`);
        return encodeURIComponent(value);
      });
      const response = await f.call(target, entry.method, undefined, f.creator, entry.headers);
      const body: unknown = await response.json().catch(() => null);
      expect(response.status, `${entry.id} answered ${JSON.stringify(body)}`).toBeLessThan(300);
      const parsed = z.fromJSONSchema(entry.response as never).safeParse(body);
      expect(parsed.success ? [] : parsed.error.issues, `${name} would reject ${entry.id}`).toEqual([]);
    });
  });
}
