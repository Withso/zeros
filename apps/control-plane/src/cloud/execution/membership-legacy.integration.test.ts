import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystemTx } from "../../db.js";
import { executionFixture, type ExecutionFixture } from "./test-fixture.js";

const database = process.env.TEST_DATABASE_URL ? describe : describe.skip;
database("membership policy with a legacy worker and desktop", () => {
  let pool: pg.Pool, f: ExecutionFixture;
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(async () => { f = await executionFixture(pool); await f.login(); });
  afterEach(async () => { await f?.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  afterAll(() => pool.end());
  const disconnect = () => withSystemTx(pool, tx => tx.query("DELETE FROM cloud_github_selections WHERE org_id=$1 AND owner_user_id=$2", [f.organizationId, f.creator.id]));

  it("reads and connects the legacy Creator without a GitHub connection, retaining the old teammate execution guard", async () => {
    expect((await f.hello()).status).toBe(200);
    await disconnect(); f.fetcher.mockClear();
    const root = `/v1/cloud-v2/workspaces/${f.workspace.id}`;
    for (const [path, method, body] of [[root, "GET", undefined], [root+"/history", "POST", { op: "chats.list", params: {} }],
      [root+"/connect", "POST", { wake: false }]] as const) {
      expect((await f.call(path, method, body, f.creator)).status).toBe(200);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await f.call(root+"/connect", "POST", { wake: false }, f.viewer, { "X-Zeros-Team-Sharing": "1" })).status).toBe(409);
  });

  it("boots and refreshes a legacy worker without repository verification or a live Git profile lookup", async () => {
    await disconnect(); f.fetcher.mockClear();
    expect((await f.hello("git-identity-v1,github-user-token-v1,prompt-outbox-v1,checkout-v2,workspace-environment-v1,repository-setup-v1")).status).toBe(200);
    expect(f.fetcher).not.toHaveBeenCalled();
    const response = await f.worker("config", undefined, { method: "GET" });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toMatch(/legacyBasis|workerTokenHash|execution_authority/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it("refuses a legacy document when the Creator loses membership during the metadata read", async () => {
    const metadata = f.cp.teamSharing.github.metadata;
    const documents = metadata.documents.bind(metadata);
    const held = vi.spyOn(metadata, "documents").mockImplementationOnce(async (...args) => {
      const result = await documents(...args);
      const removed = await withSystemTx(pool, tx => tx.query("DELETE FROM organization_members WHERE org_id=$1 AND user_id=$2", [f.organizationId, f.creator.id]));
      expect(removed.rowCount).toBe(1);
      return result;
    });
    const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspace.id}`, "GET", undefined, f.creator);
    expect(held).toHaveBeenCalledOnce();
    expect(response.status).toBe(404);
    expect(await response.json()).not.toHaveProperty("workspace");
  });
});
