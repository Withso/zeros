import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { WorkspaceBlobError } from "./object-store.js";
import {
  CLOUD_WORKSPACE_BLOB_PATH,
  createCloudWorkspaceInternalRoutes,
  type CloudWorkspaceInternalSetupService,
} from "./internal-routes.js";

it("authenticates valid-shaped upload capabilities before reserving any shared ingress capacity", async () => {
  const validToken = `zwh_${"A".repeat(43)}`;
  const invalidToken = `zwh_${"B".repeat(43)}`;
  const scope = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    generation: 1,
    engineInstanceId: "33333333-3333-4333-8333-333333333333",
  };
  const authorizeBlobUpload = vi.fn(async (token: string) => {
    if (token !== validToken) throw new WorkspaceBlobError("engine_authority_rejected", "Rejected");
  });
  const putBlob = vi.fn(), putBlobBatch = vi.fn(async () => ({ blobs: [] }));
  const app = new Hono();
  app.route("/", createCloudWorkspaceInternalRoutes({
    redeem: vi.fn(), registerEngine: vi.fn(), heartbeat: vi.fn(), getBlob: vi.fn(),
    authorizeBlobUpload, putBlob, putBlobBatch,
  } as unknown as CloudWorkspaceInternalSetupService));
  const query = new URLSearchParams({ ...scope, generation: "1" });
  const close: Array<() => void> = [], pending: Array<Promise<Response>> = [];
  try {
    for (const path of [CLOUD_WORKSPACE_BLOB_PATH, `${CLOUD_WORKSPACE_BLOB_PATH}/batch`]) {
      for (let index = 0; index < 2; index++) {
        const body = new ReadableStream({ start(controller) { close.push(() => { try { controller.close(); } catch { /* Already cancelled. */ } }); } });
        pending.push(app.request(path.endsWith("/batch") ? path : `${path}?${query}`, {
          method: "POST", headers: { authorization: `Bearer ${invalidToken}`,
            "content-type": path.endsWith("/batch") ? "application/json" : "application/octet-stream" },
          body, duplex: "half",
        } as RequestInit));
      }
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    const valid = await app.request(`${CLOUD_WORKSPACE_BLOB_PATH}/batch`, {
      method: "POST", headers: { authorization: `Bearer ${validToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ...scope, entries: [{ bytesBase64: "" }] }),
    });
    expect(valid.status).toBe(200);
    const invalid = await Promise.race([
      Promise.all(pending).then(responses => responses.map(response => response.status)),
      new Promise(resolve => setTimeout(() => resolve("body still buffered"), 100)),
    ]);
    expect(invalid).toEqual([401, 401, 401, 401]);
    expect(authorizeBlobUpload).toHaveBeenCalledTimes(5);
    expect(putBlob).not.toHaveBeenCalled();
    expect(putBlobBatch).toHaveBeenCalledOnce();
  } finally {
    for (const release of close) release();
    await Promise.allSettled(pending);
  }
});
