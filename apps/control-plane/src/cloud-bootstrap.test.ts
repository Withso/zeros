import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { HttpError } from "./authz.js";
import { loadConfig } from "./config.js";
import { createRoutes } from "./routes.js";
import { cloudAgentCredentialKeys, DatabaseCloudAgentCredentialService } from "./cloud-workspaces/agent-credentials.js";

const owner = "11111111-1111-4111-8111-111111111111", credential = "22222222-2222-4222-8222-222222222222";
const organization = "33333333-3333-4333-8333-333333333333";
const config = loadConfig({ DATABASE_URL: "postgresql://app@localhost/zeros", AUTH0_DOMAIN: "example.test",
  AUTH_AUDIENCE: "https://api.example.test", CLOUD_WORKSPACES_ENABLED: "false",
  CLOUD_WORKSPACE_SECRET_KEYS_JSON: JSON.stringify({ "1": Buffer.alloc(32, 1).toString("base64url") }) });
const pool = { query: () => { throw new Error("Bootstrap customer gates must reject before database access"); } } as unknown as pg.Pool;
const email = { from: null, token: null, apiUrl: "", inviteLinkBase: "" } as never;

describe("cloud-off credential bootstrap HTTP boundaries", () => {
  it("allows encrypted account connections without mounting customer execution, delegation or customization", async () => {
    const list = vi.spyOn(DatabaseCloudAgentCredentialService.prototype, "list").mockResolvedValue({ credentials: [] });
    const put = vi.spyOn(DatabaseCloudAgentCredentialService.prototype, "put").mockResolvedValue({ credential: { id: credential } } as never);
    try {
      const app = new Hono();
      app.use("*", async (context, next) => { context.set("user", { id: owner } as never); await next(); });
      app.onError((error, context) => error instanceof HttpError ? context.json({ error: error.code }, error.status) : context.json({ error: "unexpected" }, 500));
      app.route("/", createRoutes(pool, email, config.cloudWorkspaces, { cloudAgentCredentialKeys: cloudAgentCredentialKeys(config.cloudAgentCredentials!) }));
      expect((await app.request("/v1/cloud-agent-credentials")).status).toBe(200);
      expect(list).toHaveBeenCalledWith(owner);
      const input = { operationId: organization, expectedRevision: 0, displayName: "Cursor",
        material: { kind: "cursor-api-key", apiKey: "synthetic-bootstrap-cursor-secret" } };
      const response = await app.request(`/v1/cloud-agent-credentials/${credential}`, { method: "PUT",
        headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      expect(response.status).toBe(200); expect(await response.text()).not.toContain(input.material.apiKey);
      expect(put).toHaveBeenCalledWith({ ...input, ownerUserId: owner, credentialId: credential });
      for (const [method, path] of [["GET", `/v1/organizations/${organization}/customization`],
        ["POST", "/v1/cloud-agent-credentials/delegations"], ["POST", `/v1/cloud-workspaces/${credential}/agent-credentials/prepare`],
        ["POST", "/internal/v2/cloud-workspaces/engine/agent-execution"]]) {
        expect((await app.request(path, { method })).status).toBe(404);
      }
      for (const path of [`/v1/organizations/${organization}/cloud-workspaces`,
        `/v1/organizations/${organization}/cloud-workspaces/${credential}/generations`]) {
        expect((await app.request(path, { method: "POST" })).status).toBe(503);
      }
    } finally { list.mockRestore(); put.mockRestore(); }
  });
  it("keeps normal authentication and maintenance/migration fences ahead of bootstrap credentials", async () => {
    const list = vi.spyOn(DatabaseCloudAgentCredentialService.prototype, "list");
    try {
      expect((await createApp(config, pool, email).request("/v1/cloud-agent-credentials")).status).toBe(401);
      expect((await createApp({ ...config, databaseMaintenanceMode: true }, pool, email).request("/v1/cloud-agent-credentials")).status).toBe(503);
      const pending = createApp(config, pool, email, { migrationStatus: {
        state: "controlled_migration_pending", migration: "0025_cloud_workspaces.sql", dependentRuntime: "cloud_workspaces" } });
      expect((await pending.request("/v1/cloud-agent-credentials")).status).toBe(503);
      expect((await pending.request(`/v1/organizations/${organization}/agent-connections`)).status).toBe(503);
      expect(list).not.toHaveBeenCalled();
    } finally { list.mockRestore(); }
  });
});
