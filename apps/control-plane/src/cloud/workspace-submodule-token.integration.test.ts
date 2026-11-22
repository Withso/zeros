// C4 change 3: a submodule's token is read-only. The worker names a submodule's repository (credential.useHttpPath);
// the control plane mints an installation token of the creator's own installation for that one repository with
// exactly metadata and contents read, and only for a submodule this workspace fetches, for Git.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GithubBackendConfig } from "../config.js";
import { withSystemTx } from "../db.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudGithubConnections } from "./github-connections.js";
import type { CloudGithubConnectionStore, CloudGithubCredentialSnapshot } from "./github-connections-store.js";
import { createSelectedCloudGithubTokens } from "./github-selected-tokens.js";
import type { CloudV2Workspace } from "./store.js";
import { submoduleGitDirName } from "./submodules.js";
import { insertWorkspaceSubmodules, workspaceRepositoryToken } from "./workspace-submodules.js";

const d = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const config = {
  appId: 5, clientId: "fixture-client", apiBaseUrl: "https://api.github.com", variantKey: "github.com",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
} as GithubBackendConfig;

/** The creator's GitHub: acme/lib (501) and acme/other (502), both theirs to read, under their installation of the App. */
function github(method: "github-app" | "pat" = "github-app") {
  const snapshot: CloudGithubCredentialSnapshot = { generation: "fixture-generation", identity: { id: "12", login: "contributor" }, assertCurrent: async () => {},
    material: method === "pat" ? { method, accessToken: "fixture-personal", expiresAt: null }
      : { method, accessToken: "fixture-human-app", refreshToken: "fixture-refresh", expiresAt: Date.now() + 3_600_000, refreshExpiresAt: Date.now() + 86_400_000 } };
  const issued: unknown[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const id = /^\/repositories\/(50[12])/.exec(path)?.[1];
    if (path === "/user") return Response.json({ id: 12, login: "contributor" });
    if (id && path.endsWith("/branches")) return Response.json([]);
    if (id) return Response.json({ id: Number(id), name: id === "501" ? "lib" : "other", owner: { login: "acme" }, default_branch: "main", private: true,
      archived: false, permissions: { push: true } });
    if (path === "/repos/acme/lib") return Response.json({ id: 501, full_name: "acme/lib" });
    if (path === "/user/installations") return Response.json({ installations: [{ id: 7, app_id: 5, account: { login: "acme" }, suspended_at: null }] });
    if (path.endsWith("/access_tokens")) {
      const body = JSON.parse(String(init?.body));
      issued.push(body);
      return Response.json({ token: `fixture-installation-${issued.length}`, permissions: body.permissions,
        expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 });
    }
    if (path === "/installation/token") return new Response(null, { status: 204 });
    if (path.endsWith("/collaborators/contributor/permission")) return Response.json({ permission: "write", user: { id: 12, login: "contributor" } });
    throw new Error(`Unexpected fixture request ${path}`);
  });
  const connections = new CloudGithubConnections({ credential: async () => snapshot } as unknown as CloudGithubConnectionStore, config, fetcher);
  return { token: createSelectedCloudGithubTokens({ query: vi.fn() } as unknown as pg.Pool, connections, fetcher), issued, fetcher };
}

d("a submodule's token", () => {
  let pool: pg.Pool, org: string, creator: string;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 }); });
  afterAll(async () => { await pool.end(); });
  beforeEach(async () => {
    await resetMigratedTestDatabase(pool);
    creator = randomUUID(); org = randomUUID();
    await pool.query("INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'U')", [creator, `u-${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations (id, slug, name, created_by, is_personal, cloud_workspaces_allowed) VALUES ($1,$2,'Org',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members (org_id, user_id, role) VALUES ($1,$2,'owner')", [org, creator]);
  });
  /** A workspace of withso/app with acme/lib planned (fetch) and acme/other only in the project's copy (readable). */
  const workspace = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO cloud_v2_workspaces (id, org_id, creator_user_id, name, repository, branch, base_branch, state)
      VALUES ($1,$2,$3,'w','withso/app',$4,'main','creating')`, [id, org, creator, `zeros/${id.slice(0, 8)}`]);
    await withSystemTx(pool, tx => insertWorkspaceSubmodules(tx, id, [
      { position: 0, path: "lib", status: "fetch", repository: "acme/lib", repositoryId: "501", commit: "a".repeat(40), gitDir: `modules/${submoduleGitDirName("lib")}` },
      { position: 0, path: "other", status: "readable", repository: "acme/other", repositoryId: "502" }]));
    return { id, organizationId: org, creatorUserId: creator, repository: "withso/app" } as CloudV2Workspace;
  };

  it("mints exactly metadata and contents read, for that one repository, cached no longer than a user token", async () => {
    const gh = github(), w = await workspace(), release = vi.fn(async () => {});
    const granted = await workspaceRepositoryToken(pool, gh.token, w, "ACME/lib", "git", release);
    expect(granted.token).toBe("fixture-installation-2");
    expect(granted.expiresAt).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(Object.keys(granted)).toEqual(["token", "expiresAt"]);
    // The first is the identity probe (revoked); the second is the token the worker gets. Neither can write.
    expect(gh.issued).toEqual([
      { repository_ids: [501], permissions: { metadata: "read" } },
      { repository_ids: [501], permissions: { metadata: "read", contents: "read" } }]);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses gh, a submodule it doesn't fetch, another workspace's, and a personal access token, minting nothing", async () => {
    const gh = github(), w = await workspace(), other = await workspace(), release = async () => {};
    await pool.query("DELETE FROM cloud_v2_workspace_submodules WHERE workspace_id=$1", [w.id]);
    await expect(workspaceRepositoryToken(pool, gh.token, other, "acme/lib", "gh", release)).rejects.toMatchObject({ status: 403, code: "github_repository_access_required" });
    await expect(workspaceRepositoryToken(pool, gh.token, other, "acme/other", "git", release)).rejects.toMatchObject({ status: 403, code: "github_repository_access_required" });
    await expect(workspaceRepositoryToken(pool, gh.token, w, "acme/lib", "git", release)).rejects.toMatchObject({ status: 403, code: "github_repository_access_required" });
    expect(gh.fetcher).not.toHaveBeenCalled();
    const pat = github("pat");
    await expect(workspaceRepositoryToken(pool, pat.token, other, "acme/lib", "git", release)).rejects.toMatchObject({ status: 403, code: "github_access_required" });
    expect(pat.issued).toEqual([]);
  });
});
