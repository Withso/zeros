import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { engineConnectProgram, readEngineConnectSource, runEngineConnectRepro } from "../cloud-workspace-validation/engine-connect-repro.mjs";
import { closeIdentity, probeEngineSocket, sanitizeEngineConnectProbe, summarizeEngineLog } from "../cloud-workspace-validation/engine-connect-probe.mjs";
import { newTemplateSetupJournal } from "../cloud-workspace-validation/template-setup-repro.mjs";
import { CloudProviderError } from "../../apps/control-plane/src/cloud-workspaces/provider";
import { resetMigratedTestDatabase } from "../../apps/control-plane/src/test-database";
import { seedReadyCloudWorkspace } from "../../apps/control-plane/src/cloud-workspaces/test-fixtures";

const emptyProbe = { schema: "zeros.engine-connect-probe/v1", mode: "read_only", previousLog: { state: "absent" }, serve: null };
function fixture(state = "archived") {
  const sourceId = "bx_3456789a", childId = "bx_23456789", billingOrg = `team_${randomUUID()}`;
  const journal = newTemplateSetupJournal(randomUUID(), 1, sourceId);
  const material = { sourceId, image: { resources: { architecture: "linux/amd64", cpuMillicores: 4000, memoryMiB: 8192, storageMiB: 20480 } } };
  let deleted = false;
  const request = vi.fn(async (url: string, options: any = {}) => {
    if (url.endsWith("/fork")) return { sandboxId: childId, sourceSandboxId: sourceId };
    if (options.method === "DELETE") { deleted = true; return { operation: { id: `bdop_${"d".repeat(32)}`, targetId: childId } }; }
    if (url.startsWith("/deletion-operations/")) return { operation: { id: `bdop_${"d".repeat(32)}`, targetId: childId,
      kind: "sandbox", status: "blocked", stage: "waiting_for_uploads" } };
    if (deleted && url === `/sandboxes/${childId}`) throw new CloudProviderError("provider_not_found", "private", false, { httpStatus: 404 });
    return { sandbox: { id: sourceId, state, snapshotAvailable: true, lastSnapshotStatus: "completed", team: { id: billingOrg } } };
  });
  const deps = { request, save: vi.fn(), diagnose: vi.fn(), ready: vi.fn(), probe: vi.fn(async () => emptyProbe), wait: async () => {} };
  return { journal, material, billingOrg, sourceId, childId, deps };
}
describe("engine connection operator diagnostics", () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)("reads the v4 timeline from the migrated schema", async () => {
    const { Pool } = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1 });
    try {
      await resetMigratedTestDatabase(pool);
      const fixture = await seedReadyCloudWorkspace(pool, { runtimeV4: true });
      await pool.query("UPDATE cloud_workspace_provider_bindings SET provider_resource_id='bx_3456789a' WHERE workspace_id=$1", [fixture.workspaceId]);
      const result = await readEngineConnectSource(pool, fixture.workspaceId);
      expect(result.sourceId).toBe("bx_3456789a");
      expect(result.timeline.engines).toEqual([expect.objectContaining({ id: fixture.engineInstanceId, protocolVersion: 20 })]);
    } finally { await pool.end(); }
  }, 30_000);
  it("forks only the archived workspace and releases it after a probe failure", async () => {
    const f = fixture(); f.deps.probe.mockRejectedValue(new Error("private remote body"));
    const result = await runEngineConnectRepro(f.journal, f.material, f.billingOrg, f.deps);
    expect(result.cleanup).toBe("verified");
    expect(result.cleanupStorageStage).toBe("waiting_for_uploads");
    expect(result.failedChecks).toEqual(["probe_failed"]);
    expect(f.deps.request).toHaveBeenCalledWith(`/sandboxes/${f.sourceId}/fork`, expect.objectContaining({
      body: { type: "default", ttlSeconds: 1800, noEnv: true, env: {} }, idempotencyKey: expect.stringMatching(/^zeros-v2-test-/) }));
    expect(f.deps.request).not.toHaveBeenCalledWith(`/sandboxes/${f.sourceId}`, expect.objectContaining({ method: "DELETE" }));
  });
  it("inspects a running source without starting an engine or changing its lifecycle", async () => {
    const f = fixture("running");
    const result = await runEngineConnectRepro(f.journal, f.material, f.billingOrg, f.deps);
    expect(result.cleanup).toBe("not_created");
    expect(f.deps.request).toHaveBeenCalledExactlyOnceWith(`/sandboxes/${f.sourceId}`);
    expect(f.deps.probe).toHaveBeenCalledWith(f.sourceId, expect.objectContaining({ fork: false }));
    expect(f.deps.ready).not.toHaveBeenCalled();
  });
  it("refuses a different provider wallet without allocation or probe", async () => {
    const f = fixture();
    await runEngineConnectRepro(f.journal, f.material, `team_${randomUUID()}`, f.deps);
    expect(f.deps.request).toHaveBeenCalledTimes(1); expect(f.deps.probe).not.toHaveBeenCalled();
  });
  it("reports an unsuccessful handshake or retirement while still releasing the fork", async () => {
    const f = fixture();
    const result = await runEngineConnectRepro(f.journal, f.material, f.billingOrg, f.deps);
    expect(result.cleanup).toBe("verified");
    expect(result.failedChecks).toEqual(["engine_connection_failed", "engine_retirement_failed"]);
  });
  it("reads state and revocation evidence in a rollback-only transaction", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM cloud_workspaces w")) return { rows: [{ org_id: randomUUID(), status: "stopped", desired_state: "stopped",
        current_generation: 1, provider_resource_id: "bx_3456789a", runtime_id: `r1-${"a".repeat(64)}`,
        runtime_base_image_id: "zeros-v2-test-base", architecture: "linux/amd64", cpu_millicores: 4000, memory_mib: 8192, storage_mib: 20480 }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const result = await readEngineConnectSource({ connect: async () => ({ query, release }) }, randomUUID());
    expect(result.timeline.workspace.status).toBe("stopped");
    expect(query.mock.calls[0]![0]).toBe("BEGIN READ ONLY");
    expect(query.mock.calls.at(-1)![0]).toBe("ROLLBACK");
    expect(query.mock.calls.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /token_hash|registration_grant_id|SELECT \*/.test(sql))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
  it("never returns arbitrary log lines, messages or socket reasons", () => {
    const privateText = "private-auth-value-never-output";
    const log = summarizeEngineLog(`[Zeros] Browser connected\nTypeError: ${privateText}\nEACCES /private/${privateText}`);
    expect(log.counts.browser_connected).toBe(1); expect(log.counts.permission_denied).toBe(1);
    const sanitized = sanitizeEngineConnectProbe({ ...emptyProbe, previousLog: { state: "read", ...log, extra: privateText },
      serve: { ready: true, socket: { close: { code: 1008, reason: privateText }, rejection: privateText, error: privateText }, log,
        authority: privateText }, extra: privateText });
    expect(JSON.stringify(sanitized)).not.toContain(privateText);
    expect(closeIdentity(1008, "client authority expired")).toEqual({ code: 1008, reason: "client authority expired" });
  });
  it("builds a bounded Python payload without shell interpolation or files on the source", () => {
    const script = engineConnectProgram("export async function engineConnectProbe() { return {}; }", { fork: false });
    execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: script });
    expect(script).not.toContain("write_text"); expect(script).not.toContain("shell=True");
  });
  it.each([false, true])("captures a real upstream handshake and closed reason (close=%s)", async close => {
    const server = createServer(), wss = new WebSocketServer({ server });
    wss.on("connection", socket => {
      socket.send(JSON.stringify({ type: "ENGINE_READY" }));
      socket.on("message", data => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "WORKSPACE_REQUEST") {
          if (close) socket.close(1008, "client authority expired");
          else socket.send(JSON.stringify({ type: "WORKSPACE_RESPONSE", requestId: msg.id, result: [] }));
        }
      });
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const result = await probeEngineSocket(WebSocket, (server.address() as { port: number }).port, "test-only", "test-only", 20, 1000);
      expect(result.opened).toBe(true); expect(result.connectedSent).toBe(true);
      expect(result.workspaceResponse).toBe(!close);
      expect(result.close).toEqual(close ? { code: 1008, reason: "client authority expired" } : null);
    } finally { for (const socket of wss.clients) socket.terminate(); wss.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
