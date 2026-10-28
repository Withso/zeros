import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { withUserTx } from "../db.js";
import { McpStore } from "./store.js";
import { SECRET_REF } from "./model.js";
import { CloudV2Store } from "../cloud/store.js";
import { sealMcpMaterial } from "./envelope.js";

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

  it("uses explicit cloud repository authority for configuration without widening Local runtime admission", async () => {
    const final = vi.fn(async () => {}), authorize = vi.fn(async () => ({ repositoryId: "42", assertCurrent: final }));
    const selected = new McpStore(pool, keys, async () => ["org/repo"], authorize);
    const id = randomUUID();
    await selected.put(org, member, id, input("user", "cloud/project"), "cloud");
    expect(authorize).toHaveBeenCalledWith(org, member, "cloud/project");
    expect(final).toHaveBeenCalledOnce();
    await expect(selected.resolve(org, member, "cloud/project")).rejects.toMatchObject({ code: "repository_not_found" });
    expect(await selected.resolve(org, member, "cloud/project", { repositoryId: "42" })).toMatchObject([{ id }]);
    await selected.put(org, member, randomUUID(), input("user", "org/repo"));
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("does not release a name-only repository's MCP secrets to a cloud workspace reusing that name", async () => {
    const id = randomUUID();
    await store.put(org, admin, id, input("organization", "org/repo"));
    // The old definition predates immutable identity recording. A newly
    // admitted workspace can belong to a different repository at the same name;
    // current access to that name cannot establish the definition's provenance.
    expect(await store.resolve(org, member, "org/repo", { repositoryId: "99" })).toEqual([]);
    expect(await store.resolve(org, member, "org/repo")).toMatchObject([{ id }]);
  });

  it("retains an ID-bound definition across a transfer and excludes a replacement name in Local and cloud", async () => {
    const catalog = [{ repository: "org/repo", repositoryId: "42" }];
    let selectedId = "42";
    const selected = new McpStore(pool, keys, async () => catalog,
      async () => ({ repositoryId: selectedId, assertCurrent: async () => {} }));
    const id = randomUUID();
    const original = await selected.put(org, admin, id, input("organization", "org/repo"), "cloud");
    expect((await selected.get(org, admin, id)).repository_id).toBe("42");
    catalog.splice(0, catalog.length, { repository: "org/repo", repositoryId: "99" },
      { repository: "current/project", repositoryId: "42" });
    expect(await selected.resolve(org, member, "current/project", { repositoryId: "42" })).toMatchObject([{ id, env: { KEY: "fixture-secret" } }]);
    expect(await selected.resolve(org, member, "current/project")).toMatchObject([{ id }]);
    expect(await selected.resolve(org, member, "org/repo", { repositoryId: "99" })).toEqual([]);
    expect(await selected.resolve(org, member, "org/repo")).toEqual([]);

    selectedId = "99";
    await expect(selected.put(org, admin, id, { ...input("organization", "org/repo"), expectedRevision: 1,
      config: original.config }, "cloud")).rejects.toMatchObject({ code: "mcp_repository_changed" });
    expect((await selected.get(org, admin, id)).revision).toBe(1);
    selectedId = "42";
    await selected.put(org, admin, id, { ...input("organization", "current/project"), expectedRevision: 1,
      config: original.config }, "cloud");
    expect((await selected.get(org, admin, id)).repository_id).toBe("42");
    expect(await selected.resolve(org, member, "org/repo", { repositoryId: "42" })).toMatchObject([{ id }]);
  });

  it("records native admission IDs for cloud use without allowing an old catalog to erase them", async () => {
    let catalog: { repository: string; repositoryId?: string }[] = [{ repository: "org/repo", repositoryId: "42" }];
    const selected = new McpStore(pool, keys, async () => catalog), id = randomUUID();
    const original = await selected.put(org, admin, id, input("organization", "org/repo"));
    expect(await selected.resolve(org, member, "org/repo", { repositoryId: "42" })).toMatchObject([{ id }]);
    catalog = [{ repository: "org/repo" }];
    expect(await selected.resolve(org, member, "org/repo")).toEqual([]);
    await expect(selected.put(org, admin, id, { ...input("organization", "org/repo"), expectedRevision: 1,
      config: original.config })).rejects.toMatchObject({ code: "mcp_repository_changed" });
    expect((await selected.get(org, admin, id)).repository_id).toBe("42");
  });

  it("withdraws a definition's ID proof when an older API saves a new revision without that proof", async () => {
    const selected = new McpStore(pool, keys, async () => [{ repository: "org/repo", repositoryId: "42" }]);
    const id = randomUUID();
    await selected.put(org, admin, id, input("organization", "org/repo"));
    const envelope = sealMcpMaterial({ env: { KEY: "fixture-replacement-secret" } },
      { organizationId: org, ownerUserId: null, id, revision: 2, purpose: "config" }, keys);
    // The preceding writer atomically updates config/secrets/revision, but
    // knows only the repository name and cannot affirm a previously saved ID.
    await pool.query("UPDATE organization_extensions SET revision=2,secret_envelope=$2 WHERE id=$1", [id, envelope]);
    expect(await selected.resolve(org, member, "org/repo", { repositoryId: "42" })).toEqual([]);
    expect(await selected.resolve(org, member, "org/repo")).toEqual([]);
  });

  it("refreshes only the original workspace after a transferred repository's definition changes", async () => {
    await pool.query("UPDATE organizations SET cloud_workspaces_allowed=true WHERE id=$1", [org]);
    const workspaces = new CloudV2Store(pool);
    const original = await workspaces.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: member,
      name: "original", repository: "org/repo", sourceRepositoryId: "42", branch: "work", baseBranch: "main", computerBuildId: null });
    const replacement = await workspaces.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: member,
      name: "replacement", repository: "current/project", sourceRepositoryId: "99", branch: "work", baseBranch: "main", computerBuildId: null });
    const selected = new McpStore(pool, keys, async () => [],
      async () => ({ repositoryId: "42", assertCurrent: async () => {} }));
    const saved = await selected.put(org, admin, randomUUID(), input("organization", "current/project"), "cloud");
    expect(await workspaces.loginRevision(original.id)).toBe("1");
    expect(await workspaces.loginRevision(replacement.id)).toBe("0");
    await selected.remove(org, admin, saved.id, saved.revision);
    expect(await workspaces.loginRevision(original.id)).toBe("2");
    expect(await workspaces.loginRevision(replacement.id)).toBe("0");
  });

  it("rolls back a cloud-scoped configuration when its connection changes after preflight", async () => {
    const selected = new McpStore(pool, keys, async () => ["org/repo"], async () => ({ repositoryId: "42", assertCurrent: async () => { throw new Error("connection changed"); } }));
    const id = randomUUID();
    await expect(selected.put(org, member, id, input("user", "cloud/project"), "cloud")).rejects.toThrow("connection changed");
    expect((await pool.query("SELECT id FROM organization_extensions WHERE id=$1", [id])).rowCount).toBe(0);
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

  it("allocates fresh 32-byte opaque markers for independent identical drafts and saved configurations", async () => {
    const oauthConfig = { name: "shared", transport: "http" as const, url: "https://shared.example.test/mcp", auth: "oauth" as const,
      oauth_client_id: "fixture-client", oauth_scopes: ["read"] };
    const secrets = { oauthClientSecret: "fixture-secret" };
    const first = await store.draft(org, admin, { config: oauthConfig, secrets });
    const second = await store.draft(org, admin, { config: oauthConfig, secrets });
    const shared = await store.put(org, admin, randomUUID(), { ...input("organization"), config: oauthConfig, secrets });
    const privateEntry = await store.put(org, member, randomUUID(), { ...input("user"), config: oauthConfig, secrets });
    const bindings = [first.binding, second.binding, (await store.get(org, admin, shared.id)).oauth_binding,
      (await store.get(org, member, privateEntry.id)).oauth_binding];
    for (const binding of bindings) expect(binding).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(bindings).size).toBe(4);
  });

  it("keeps unchanged markers but never regenerates a historical marker when an OAuth identity returns", async () => {
    const oauthConfig = { name: "shared", transport: "http" as const, url: "https://shared.example.test/mcp", auth: "oauth" as const,
      oauth_client_id: "fixture-client", oauth_scopes: ["read"] };
    const entry = await store.put(org, admin, randomUUID(), { ...input("organization"), config: oauthConfig, secrets: { oauthClientSecret: "fixture-secret" } });
    const original = (await store.get(org, admin, entry.id)).oauth_binding;
    const unchanged = { ...oauthConfig, name: "renamed", oauth_client_mode: "custom", oauth_scopes: ["read", "read"] };
    await store.put(org, admin, entry.id, { ...input("organization"), expectedRevision: 1, config: unchanged });
    expect((await store.get(org, admin, entry.id)).oauth_binding).toBe(original);
    await store.put(org, admin, entry.id, { ...input("organization"), expectedRevision: 2, config: { ...unchanged, url: "https://changed.example.test/mcp" } });
    const changed = (await store.get(org, admin, entry.id)).oauth_binding;
    expect(changed).not.toBe(original);
    await store.put(org, admin, entry.id, { ...input("organization"), expectedRevision: 3, config: unchanged });
    const returned = (await store.get(org, admin, entry.id)).oauth_binding;
    expect(returned).toMatch(/^[a-f0-9]{64}$/);
    expect(returned).not.toBe(changed);
    expect(returned).not.toBe(original);
  });

  it.each(["current", "legacy", "hmac"])("retains an unchanged %s OAuth binding for members and saves across server-key rotation", async format => {
    const entry = await store.put(org, admin, randomUUID(), { ...input("organization"), config: {
      name: "shared", transport: "http", url: "https://shared.example.test/mcp", auth: "oauth", oauth_client_id: "fixture-client", oauth_scopes: ["b", "a"],
    }, secrets: { oauthClientSecret: "fixture-secret" } });
    // Historical SHA/HMAC values are opaque fixtures; never generate a credential digest.
    if (format !== "current") await pool.query("UPDATE organization_extensions SET oauth_binding=$2 WHERE id=$1", [entry.id, (format === "legacy" ? "ab" : "cd").repeat(32)]);
    const previous = await store.get(org, admin, entry.id);
    const rotatedKeys = { currentKeyVersion: 2, keys: { ...keys.keys, 2: randomBytes(32).toString("base64url") } };
    const rotated = new McpStore(pool, rotatedKeys, async () => ["org/repo"]);
    const unchanged = { ...entry.config, oauth_client_mode: "custom", oauth_scopes: ["a", "b", "a"], disabled_tools: ["disabled"] };
    const draft = await rotated.draft(org, member, { extensionId: entry.id, expectedRevision: 1, config: unchanged });
    expect(draft.binding).toBe(previous.oauth_binding);
    expect(draft.secrets.oauthClientSecret).toBe("fixture-secret");
    const saved = await rotated.put(org, admin, entry.id, { ...input("organization"), expectedRevision: 1, config: unchanged });
    const row = await rotated.get(org, admin, entry.id);
    expect(row.oauth_binding).toBe(previous.oauth_binding);
    expect(row.secret_envelope.keyVersion).toBe(2);
    expect(rotated.secrets(row)).toEqual({ oauthClientSecret: "fixture-secret" });
    const oldCurrent = new McpStore(pool, { ...rotatedKeys, currentKeyVersion: 1 }, async () => ["org/repo"]);
    expect((await oldCurrent.draft(org, member, { extensionId: entry.id, expectedRevision: saved.revision, config: saved.config })).binding).toBe(previous.oauth_binding);
    const retiredOldKey = new McpStore(pool, { currentKeyVersion: 2, keys: { 2: rotatedKeys.keys[2] } }, async () => ["org/repo"]);
    expect((await retiredOldKey.draft(org, member, { extensionId: entry.id, expectedRevision: saved.revision, config: saved.config })).binding).toBe(previous.oauth_binding);
    const fresh = await rotated.put(org, member, randomUUID(), { ...input("user"), config: unchanged, secrets: { oauthClientSecret: "fixture-secret" } });
    expect((await rotated.get(org, member, fresh.id)).oauth_binding).not.toBe(previous.oauth_binding);
  });

  it("keeps every canonical OAuth identity change outside unchanged-member admission after rotation", async () => {
    const oauthConfig = { name: "shared", transport: "http" as const, url: "https://shared.example.test/mcp", auth: "oauth" as const,
      oauth_client_mode: "custom" as const, oauth_client_id: "fixture-client", oauth_scopes: ["read"] };
    const rotated = new McpStore(pool, { currentKeyVersion: 2, keys: { ...keys.keys, 2: randomBytes(32).toString("base64url") } }, async () => ["org/repo"]);
    const changes = [
      { config: { ...oauthConfig, url: "https://changed.example.test/mcp" } },
      { config: { ...oauthConfig, transport: "sse" } },
      { config: { ...oauthConfig, auth: "none" } },
      { config: { ...oauthConfig, oauth_client_mode: "dynamic" } },
      { config: { ...oauthConfig, oauth_client_id: "changed-client" } },
      { config: { ...oauthConfig, oauth_scopes: ["write"] } },
      { config: oauthConfig, secrets: { oauthClientSecret: "changed-fixture-secret" } },
    ];
    for (const [index, change] of changes.entries()) {
      const entry = await store.put(org, admin, randomUUID(), { ...input("organization"), config: { ...oauthConfig, name: `shared-${index}` }, secrets: { oauthClientSecret: "fixture-secret" } });
      const before = await store.get(org, admin, entry.id);
      const changed = { ...change, config: { ...change.config, name: `shared-${index}` } };
      await expect(rotated.draft(org, member, { extensionId: entry.id, expectedRevision: 1, ...changed })).rejects.toMatchObject({ status: 403 });
      await rotated.put(org, admin, entry.id, { ...input("organization"), expectedRevision: 1, ...changed });
      expect((await rotated.get(org, admin, entry.id)).oauth_binding).not.toBe(before.oauth_binding);
    }
  });
});
