import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withUserTx } from "../db.js";
import { McpStore } from "./store.js";
import { SECRET_REF } from "./model.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
d("organization MCP store", () => {
  let pool: pg.Pool, store: McpStore, org: string, otherOrg: string, admin: string, member: string, outsider: string;
  const keys = { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } };
  const config = { name: "tools", transport: "stdio" as const, command: "server", env: { KEY: "fixture-secret" } };
  const input = (owner: "organization" | "user", repository: string | null = null) => ({ kind: "mcp" as const, owner, repository, expectedRevision: null, config });
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => pool.end());
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    [org, otherOrg, admin, member, outsider] = Array.from({ length: 5 }, () => randomUUID());
    for (const id of [admin, member, outsider]) await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [id, `${id}@example.test`]);
    for (const id of [org, otherOrg]) await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal) VALUES($1,$2,'Fixture',$3,false)", [id, `org-${id}`, admin]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$3,'owner'),($1,$4,'member'),($2,$3,'owner'),($2,$5,'member')", [org, otherOrg, admin, member, outsider]);
    store = new McpStore(pool, keys, async organizationId => organizationId === org ? ["org/repo"] : ["other/repo"]);
  });

  it("isolates private entries and permits shared writes only to admins", async () => {
    const shared = await store.put(org, admin, randomUUID(), input("organization"));
    const mine = await store.put(org, member, randomUUID(), input("user"));
    expect((await store.list(org, member)).map(row => row.id).sort()).toEqual([shared.id, mine.id].sort());
    expect((await store.list(org, admin)).map(row => row.id)).toEqual([shared.id]);
    expect((await store.list(org, member)).find(row => row.id === shared.id)?.canEdit).toBe(false);
    await expect(store.put(org, member, randomUUID(), input("organization"))).rejects.toMatchObject({ status: 403 });
    await expect(store.list(org, outsider)).rejects.toMatchObject({ status: 404 });
    await expect(store.remove(org, admin, mine.id, mine.revision)).rejects.toMatchObject({ status: 404 });
    expect(await withUserTx(pool, member, tx => tx.query("SELECT * FROM organization_extensions"))).toMatchObject({ rowCount: 0 });
  });

  it("seals variables, validates the repository, and uses exact CAS under concurrent edits", async () => {
    const id = randomUUID(), entry = await store.put(org, member, id, input("user", "org/repo"));
    expect(entry.config.env).toEqual({ KEY: SECRET_REF });
    expect(JSON.stringify(entry)).not.toContain("fixture-secret");
    const persisted = (await pool.query("SELECT config,secret_envelope FROM organization_extensions WHERE id=$1", [id])).rows[0];
    expect(JSON.stringify(persisted)).not.toContain("fixture-secret");
    expect(await store.resolve(org, member, "org/repo")).toMatchObject([{ id, env: { KEY: "fixture-secret" } }]);
    await expect(store.put(org, member, randomUUID(), input("user", "other/repo"))).rejects.toMatchObject({ code: "repository_not_found" });
    const changes = await Promise.allSettled(["first", "second"].map(command => store.put(org, member, id, {
      ...input("user", "org/repo"), expectedRevision: 1, config: { ...entry.config, command },
    })));
    expect(changes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(changes.filter(result => result.status === "rejected")).toMatchObject([{ reason: { code: "revision_conflict" } }]);
    await expect(store.remove(org, member, id, 1)).rejects.toMatchObject({ code: "revision_conflict" });
    await pool.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [org, member]);
    await expect(store.resolve(org, member, "org/repo")).rejects.toMatchObject({ status: 404 });
  });

  it("uses canonical UUIDs for editing the encrypted identity even when the request is uppercase", async () => {
    const id = randomUUID();
    const entry = await store.put(org.toUpperCase(), member, id.toUpperCase(), input("user"));
    expect(entry.id).toBe(id);
    expect((await store.put(org.toUpperCase(), member, id.toUpperCase(), { ...input("user"), expectedRevision: entry.revision, config: entry.config })).revision).toBe(2);
    expect(await store.resolve(org, member, "org/repo")).toMatchObject([{ id, env: { KEY: "fixture-secret" } }]);
  });

  it("lets members connect to a shared server but cannot redirect its retained secret in an unsaved draft", async () => {
    const entry = await store.put(org, admin, randomUUID(), { ...input("organization"),
      config: { name: "shared", transport: "http", url: "https://shared.example.test/mcp", auth: "header", headers: { Authorization: "fixture-shared-value" } } });
    const draft = { extensionId: entry.id, expectedRevision: entry.revision, config: entry.config };
    expect((await store.draft(org, member, draft)).secrets.headers).toEqual({ Authorization: "fixture-shared-value" });
    await expect(store.draft(org, member, { ...draft, config: { ...entry.config, url: "https://different.example.test/mcp" } })).rejects.toMatchObject({ status: 403 });
    expect((await store.draft(org, admin, { ...draft, config: { ...entry.config, url: "https://different.example.test/mcp" } })).config).toMatchObject({ url: "https://different.example.test/mcp" });
  });
});
