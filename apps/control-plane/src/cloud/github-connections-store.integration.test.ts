import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudGithubConnectionStore } from "./github-connections-store.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("cloud GitHub connection ownership and rotation", () => {
  let pool: pg.Pool, store: CloudGithubConnectionStore;
  let userId: string, organizationId: string, otherUserId: string;
  const keys = {
    currentKeyVersion: 1,
    keys: { 1: Buffer.alloc(32, 3).toString("base64url") },
  };
  const pat = {
    method: "pat" as const,
    accessToken: "synthetic-personal-credential",
    expiresAt: null,
  };
  const app = {
    method: "github-app" as const,
    accessToken: "synthetic-user-app-credential",
    refreshToken: "synthetic-app-refresh-credential",
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
  };
  const identity = { id: "123", login: "contributor" };
  const scope = () => ({ userId, organizationId });
  beforeAll(() => {
    pool = new pg.Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 4,
    });
  });
  afterAll(async () => {
    await pool.end();
  });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    store = new CloudGithubConnectionStore(pool, keys);
    userId = randomUUID();
    otherUserId = randomUUID();
    organizationId = randomUUID();
    for (const id of [userId, otherUserId])
      await pool.query(
        "INSERT INTO users(id,email,display_name) VALUES($1,$2,'User')",
        [id, `${id}@example.test`],
      );
    await pool.query(
      "INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Org',$3,false,true)",
      [organizationId, `org-${organizationId}`, userId],
    );
    await pool.query(
      "INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",
      [organizationId, userId, otherUserId],
    );
  });
  async function save(material = pat, expected?: string) {
    return store.save(
      scope(),
      expected ?? (await store.status(scope())).generation,
      identity,
      material,
    );
  }
  it("keeps credentials encrypted and returns only the selected user's metadata", async () => {
    await save();
    const status = await store.status(scope());
    expect(status).toMatchObject({
      selectedMethod: "pat",
      methods: {
        pat: { configured: true, login: "contributor" },
        "github-app": { configured: false },
      },
    });
    expect(JSON.stringify(status)).not.toContain(pat.accessToken);
    expect(
      (
        await pool.query("SELECT * FROM cloud_github_credentials")
      ).rows[0].ciphertext.toString(),
    ).not.toContain(pat.accessToken);
    expect(
      (await store.status({ userId: otherUserId, organizationId }))
        .selectedMethod,
    ).toBeNull();
    await expect(
      store.credential({ userId: otherUserId, organizationId }),
    ).rejects.toMatchObject({ code: "github_connection_required" });
  });
  it("preserves inactive methods while selecting the explicit connection", async () => {
    await store.save(
      scope(),
      (await store.status(scope())).generation,
      identity,
      app,
    );
    await save();
    const status = await store.status(scope());
    await store.select(scope(), status.generation, "github-app");
    const access = await store.credential(scope());
    expect(access.material.method).toBe("github-app");
    expect((await store.status(scope())).methods.pat.configured).toBe(true);
  });
  it("rejects a delayed disconnect and save after replacement", async () => {
    await save();
    const old = (await store.status(scope())).generation;
    await save(
      { ...pat, accessToken: "synthetic-replacement-credential" },
      old,
    );
    await expect(store.disconnect(scope(), old, "pat")).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    await expect(save(pat, old)).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    expect((await store.credential(scope())).material.accessToken).toBe(
      "synthetic-replacement-credential",
    );
  });
  it("revokes issued authority after disconnect without selecting an inactive method", async () => {
    await store.save(
      scope(),
      (await store.status(scope())).generation,
      identity,
      app,
    );
    await save();
    const access = await store.credential(scope());
    await store.disconnect(
      scope(),
      (await store.status(scope())).generation,
      "pat",
    );
    await expect(access.assertCurrent()).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    await expect(store.credential(scope())).rejects.toMatchObject({
      code: "github_connection_required",
    });
    expect((await store.status(scope())).methods["github-app"].configured).toBe(
      true,
    );
  });
  it("fences A to B to A selection and current membership loss", async () => {
    await store.save(
      scope(),
      (await store.status(scope())).generation,
      identity,
      app,
    );
    await save();
    const access = await store.credential(scope());
    await store.select(
      scope(),
      (await store.status(scope())).generation,
      "github-app",
    );
    await store.select(
      scope(),
      (await store.status(scope())).generation,
      "pat",
    );
    await expect(access.assertCurrent()).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    const current = await store.credential(scope());
    await pool.query(
      "DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2",
      [organizationId, userId],
    );
    await expect(current.assertCurrent()).rejects.toMatchObject({
      code: "not_found",
    });
  });
  it("does not revive a removed App connection when a refresh finishes late", async () => {
    await store.save(
      scope(),
      (await store.status(scope())).generation,
      identity,
      { ...app, expiresAt: Date.now() - 1 },
    );
    let finish!: (value: typeof app) => void;
    const refresh = vi.fn(
      () =>
        new Promise<typeof app>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = store.credential(scope(), refresh);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await store.disconnect(
      scope(),
      (await store.status(scope())).generation,
      "github-app",
    );
    finish({ ...app, accessToken: "synthetic-refreshed-credential" });
    await expect(pending).rejects.toMatchObject({
      code: "github_authorization_changed",
    });
    expect((await store.status(scope())).methods["github-app"].configured).toBe(
      false,
    );
  });
  it("rejects a token envelope copied to a different organization or connection", async () => {
    await save();
    await pool.query(
      "UPDATE cloud_github_credentials SET generation=gen_random_uuid() WHERE owner_user_id=$1",
      [userId],
    );
    await expect(store.credential(scope())).rejects.toMatchObject({
      code: "github_authorization_expired",
    });
  });
  it("consumes OAuth state once and fences an already-consumed callback after cancel", async () => {
    await save();
    const before = (await store.status(scope())).generation;
    const expected = await store.beginOauth(
      scope(),
      before,
      "zcg_synthetic-oauth-state",
      "v".repeat(43),
    );
    const pending = await store.consumeOauth("zcg_synthetic-oauth-state");
    expect(pending).toMatchObject({ scope: scope(), expected });
    await expect(
      store.consumeOauth("zcg_synthetic-oauth-state"),
    ).rejects.toMatchObject({ code: "oauth_state_expired" });
    await store.cancelOauth(scope(), expected);
    await expect(
      store.save(pending.scope, pending.expected, identity, app),
    ).rejects.toMatchObject({ code: "github_authorization_changed" });
    expect((await store.credential(scope())).material.method).toBe("pat");
  });
});
