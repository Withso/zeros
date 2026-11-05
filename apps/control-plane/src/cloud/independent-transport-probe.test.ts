import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generateKeyPairSync } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import { expect, it } from "vitest";
import { HybridTransport } from "../../../cloud-worker/src/hybrid-transport.js";
import { HttpError } from "../authz.js";
import { grantTestPro } from "../test-pro.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { CloudV2Store } from "./store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { RuntimeAdoption } from "./runtime-adoption.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";

const test = process.env.TEST_DATABASE_URL ? it : it.skip;
test("keeps the real adopted transport authorized after an aborted second update and login refresh", async () => {
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 5 });
  const root = await mkdtemp(join(tmpdir(), "zeros-review-handoff-transport-"));
  let server: ReturnType<typeof serve> | undefined, transport: HybridTransport | undefined, adoption: RuntimeAdoption | undefined;
  try {
    await resetMigratedTestDatabase(pool);
    const user = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [user, `${user}@example.test`]);
    await grantTestPro(pool, user);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, user]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, user]);
    const store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: user, name: "Runtime", repository: "fixture/repo",
      sourceRepositoryId: "42", branch: "workspace/one", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id), old = randomUUID();
    await store.beginWorkerHello(token, old); await store.acceptWorkerHello(token, old); await handoffs.recordRuntime(token, old, "a".repeat(64));
    const revision = (await store.workerSession(token, old))!.loginRevision;
    const first = (await handoffs.prepare(token, old, { target: "b".repeat(64), instanceId: randomUUID(), revision, generation: 1 }))!;
    expect(await handoffs.commit(token, old, first.id, revision, 1, first.target_sha256)).toBe(true);
    await handoffs.activate(token, first.id); expect(await handoffs.promote(token, first.id, first.next_boot_id)).toBe(true); await handoffs.complete(first.id);
    adoption = new RuntimeAdoption({ store, handoffs, authorizeSource: async () => {},
      runtimeForWorkspace: async () => ({ sha256: "b".repeat(64), url: async () => "https://fixture.example.test/runtime" }),
      compute: { execLong: async () => ({ exitCode: 0, stdout: "", timedOut: false }) } });
    const app = new Hono();
    app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
    app.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: "b".repeat(64), runtimeUpdates: adoption, runtimeHandoffs: handoffs,
      config: async () => ({ t: "config", loginRevision: (await store.loginRevision(workspace.id))!,
        workspace: { id: workspace.id, organizationId: org, repository: "fixture/repo", branch: "workspace/one", baseBranch: "main", checkoutPath: "/home/user/fixture/repo" }, agents: {} }),
      githubToken: async () => ({ token: "synthetic-github", expiresAt: Date.now() + 60000 }) }));
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await new Promise<void>(resolve => server!.once("listening", resolve));
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const tokenFile = join(root, "worker-token"); await writeFile(tokenFile, token, { mode: 0o600 });
    const statuses: string[] = [], refreshedConfigStatuses: number[] = [];
    transport = new HybridTransport({ apiUrl, workspaceId: workspace.id, runtimeSha256: "b".repeat(64), tokenFile, port: 0,
      publicKeys: [generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString()],
      runtimeHandoff: { id: first.id, bootId: first.next_boot_id },
      onStatus: status => statuses.push(status), fetch: async (url, init) => {
        const reply = await fetch(url, init);
        if (String(url).endsWith("/config")) refreshedConfigStatuses.push(reply.status);
        return reply;
      } });
    transport.start({ open: async () => {}, frame: async raw => { if ((raw as { t?: string }).t === "config") await transport!.readyRuntime(); }, close: () => {} });
    await expect.poll(() => statuses).toContain("connected");
    const second = (await handoffs.prepare(token, first.next_boot_id, { target: "c".repeat(64), instanceId: first.instance_id, revision, generation: 2 }))!;
    expect(second).not.toBeNull(); expect(await handoffs.cancel(token, second.id, first.next_boot_id)).toBe(true);
    await pool.query("UPDATE cloud_v2_workspaces SET login_revision=login_revision+1 WHERE id=$1", [workspace.id]);
    await transport.send({ t: "idle", idle: true });
    await expect.poll(() => refreshedConfigStatuses.length).toBeGreaterThan(0);
    if (refreshedConfigStatuses[0] === 401) await expect.poll(() => statuses).toContain("unauthorized");
    expect(refreshedConfigStatuses).toEqual([200]);
    expect(statuses).not.toContain("unauthorized");
  } finally {
    await transport?.dispose(); adoption?.close();
    if (server) await new Promise<void>(resolve => { server!.closeAllConnections(); server!.close(() => resolve()); });
    await pool.end(); await rm(root, { recursive: true, force: true });
  }
}, 10000);
