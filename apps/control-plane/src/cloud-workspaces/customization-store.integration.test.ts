import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../migrate.js";
import { seedReadyCloudWorkspace } from "./test-fixtures.js";
import { DatabaseCloudCustomizationService, readCustomizationDocument, type CustomizationRow } from "./customization-store.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("organization and member customization storage", () => {
  let pool: pg.Pool, fixture: Awaited<ReturnType<typeof seedReadyCloudWorkspace>>, service: DatabaseCloudCustomizationService;
  const keys = { keys: { 1: randomBytes(32).toString("base64url") }, currentKeyVersion: 1 };
  const serverId = randomUUID();
  const document = () => ({ servers: [{ id: serverId, name: "remote", transport: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer synthetic-mcp-value" } }],
    skills: [{ name: "example", content: "# Example\nOrganization skill." }], cursorTeamSettings: "disabled" });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); await runMigrations(pool);
    fixture = await seedReadyCloudWorkspace(pool); service = new DatabaseCloudCustomizationService(pool, keys);
  });
  it("encrypts values, fences revisions and exposes secret references only", async () => {
    const view = await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() });
    expect(view).toMatchObject({ revision: 1, servers: [{ id: serverId, secretRef: serverId, headerKeys: ["Authorization"] }] });
    expect(JSON.stringify(await service.read(fixture.organizationId, fixture.userId))).not.toContain("synthetic-mcp-value");
    expect(JSON.stringify((await pool.query("SELECT * FROM cloud_customization")).rows)).not.toContain("synthetic-mcp-value");
    await expect(service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() })).rejects.toMatchObject({ status: 409 });
  });
  it("isolates organizations and member scopes and enforces administrator writes", async () => {
    const other = await seedReadyCloudWorkspace(pool);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'member')", [fixture.organizationId, other.userId]);
    await service.save(fixture.organizationId, fixture.userId, "member", { expectedRevision: 0, document: document() });
    expect((await service.read(fixture.organizationId, other.userId)).member.servers).toEqual([]);
    expect((await service.read(other.organizationId, other.userId)).organization.skills).toEqual([]);
    await expect(service.read(other.organizationId, fixture.userId)).rejects.toThrow();
    await expect(service.save(fixture.organizationId, other.userId, "organization", { expectedRevision: 0, document: document() })).rejects.toThrow();
    await service.save(fixture.organizationId, other.userId, "member", { expectedRevision: 0, document: document() });
    expect((await service.read(fixture.organizationId, other.userId)).member.revision).toBe(1);
  });
  it("supports removing skills and rotates secret maps without returning their values", async () => {
    await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() });
    const saved = document(); saved.skills = []; saved.servers[0]!.headers = {} as typeof saved.servers[0]["headers"];
    const view = await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 1, document: saved });
    expect(view.skills).toEqual([]); expect(view.servers[0]!.secretRef).toBeNull();
  });
  it("preserves encrypted headers on a skill edit, without forwarding them to a replacement endpoint", async () => {
    const saved = await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() });
    const next = { ...document(), servers: saved.servers.map(({ secretRef: _ref, envKeys: _env, headerKeys: _headers, ...server }) => server), skills: [] };
    const updated = await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 1, document: next });
    expect(updated.servers[0]!.secretRef).toBe(serverId);
    const row = (await pool.query<CustomizationRow>("SELECT * FROM cloud_customization WHERE org_id=$1", [fixture.organizationId])).rows[0];
    expect(readCustomizationDocument(row, keys).servers[0]).toMatchObject({ headers: document().servers[0]!.headers });
    const replaced = await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 2,
      document: { ...next, servers: next.servers.map(server => ({ ...server, url: "https://example.test/replacement" })) } });
    expect(replaced.servers[0]!.secretRef).toBeNull();
  });
  it("admits exactly one writer when two requests edit the same organization revision", async () => {
    const results = await Promise.allSettled([1, 2].map(() => service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() })));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toMatchObject([{ reason: { status: 409 } }]);
    expect((await service.read(fixture.organizationId, fixture.userId)).organization.revision).toBe(1);
  });
  it("RLS denies the application role without system transaction context", async () => {
    await service.save(fixture.organizationId, fixture.userId, "organization", { expectedRevision: 0, document: document() });
    const client = await pool.connect();
    try { await client.query("BEGIN"); await client.query("SET LOCAL ROLE zeros_app");
      expect((await client.query("SELECT * FROM cloud_customization")).rows).toEqual([]);
      expect((await client.query("SELECT * FROM cloud_customization_execution_snapshots")).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
