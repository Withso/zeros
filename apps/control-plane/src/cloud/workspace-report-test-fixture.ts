import { randomUUID } from "node:crypto";
import type pg from "pg";
import { expect } from "vitest";
import { CloudApiCredentials } from "./api/credentials.js";
import { createCloudApiRoutes } from "./api/routes.js";
import { CloudApiService } from "./api/service.js";
import { CloudV2Computers } from "./computer.js";
import { localCommandsFixture } from "./local-commands/test-fixture.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import type { CloudV2Workspace } from "./store.js";
import type { CloudV2Capabilities } from "./contract.js";

export async function cloudWorkspaceReportFixture(pool: pg.Pool) {
  const f = await localCommandsFixture(pool);
  f.app.route("/", createCloudV2WorkerRoutes({ store: f.store, runtimeSha256: "a".repeat(64),
    config: async () => { throw new Error("unused fixture configuration"); }, githubToken: async () => { throw new Error("unused fixture credential"); } }));
  const credentials = new CloudApiCredentials(pool);
  const key = (await credentials.create(f.organizationId, f.owner.id, "Report fixture")).key;
  const service = new CloudApiService({ store: f.store, credentials, appBaseUrl: "https://app.example.test", routes: {
    store: f.store, computers: new CloudV2Computers(pool), bridgeBaseUrl: "wss://api.example.test",
    remoteHead: async () => null, installedRepositories: async () => [],
  } });
  f.app.route("/api/v0", createCloudApiRoutes({ credentials, service }));
  await f.store.requestLifecycle(f.workspaceId, f.owner.id, "start");
  const token = await f.store.rotateWorkerToken(f.workspaceId), boot = randomUUID();
  expect(await f.store.acceptWorkerHello(token, boot)).not.toBeNull();
  return { ...f, token, boot,
    worker: (path: string, body: unknown, options: { boot?: string; feature?: string } = {}) => f.call(`/v2/cloud/worker/${path}`, "POST", body,
      { authorization: `Bearer ${token}`, "x-zeros-worker-boot": options.boot ?? boot, "x-zeros-worker-features": options.feature ?? "setup-status-v1,history-replace-v1" }),
    document: async () => {
      const response = await f.call(`/v1/cloud-v2/workspaces/${f.workspaceId}`);
      expect(response.status).toBe(200);
      return (await response.json() as { workspace: CloudV2Workspace & { capabilities: CloudV2Capabilities } }).workspace;
    },
    apiDocument: async () => {
      const response = await f.call(`/api/v0/workspaces/${f.workspaceId}`, "GET", undefined, { authorization: `Bearer ${key}` });
      expect(response.status).toBe(200); return await response.json() as Awaited<ReturnType<CloudApiService["workspace"]>>;
    },
    close: async () => { await credentials.close(); await f.signals.close(); },
  };
}
export type CloudWorkspaceReportFixture = Awaited<ReturnType<typeof cloudWorkspaceReportFixture>>;
