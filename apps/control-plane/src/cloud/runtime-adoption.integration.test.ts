import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import pg from "pg";
import WebSocket from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorker } from "../../../cloud-worker/src/worker.js";
import { HybridTransport } from "../../../cloud-worker/src/hybrid-transport.js";
import { InboundBridge } from "../../../cloud-worker/src/inbound-bridge.js";
import { runtimePermit } from "../../../cloud-worker/src/runtime-permit.js";
import { FakeDriver, browserFrame } from "../../../cloud-worker/src/__tests__/worker-fixtures.js";
import { ClaudeDriver } from "../../../cloud-worker/src/drivers/claude/driver.js";
import type { DriverOpen } from "../../../cloud-worker/src/drivers/driver.js";
import { CodeReviewAgentToolsCore } from "../../../../packages/protocol/src/code-review.js";
import { claudeNativeApi } from "../../../../packages/protocol/src/__tests__/fixtures/claude-native-api.js";
import { HttpError } from "../authz.js";
import { resetMigratedTestDatabase } from "../test-database.js";
import { grantTestPro } from "../test-pro.js";
import { CloudV2Store } from "./store.js";
import { CloudEnvironments } from "./environment-store.js";
import { RuntimeHandoffStore } from "./runtime-handoff-store.js";
import { RuntimeAdoption } from "./runtime-adoption.js";
import { createCloudV2WorkerRoutes } from "./worker-routes.js";
import { CloudV2Relay } from "./relay.js";
import { CloudV2WorkerSigner } from "./worker-auth.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("runtime adoption over worker HTTP and app WebSockets", () => {
  let pool: pg.Pool;
  const cleanup: Array<() => Promise<unknown> | void> = [];
  const settle: Array<() => Promise<void>> = [];
  beforeAll(() => { pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 }); });
  beforeEach(() => resetMigratedTestDatabase(pool));
  afterEach(async () => {
    for (const action of settle.splice(0).reverse()) await action();
    for (const action of cleanup.splice(0).reverse()) await action();
    vi.restoreAllMocks();
  });
  afterAll(() => pool.end());

  it.each([
    { fails: false, http: false, native: false, restart: false, blocker: "none" },
    { fails: true, http: false, native: false, restart: false, blocker: "none" },
    { fails: false, http: true, native: false, restart: false, blocker: "none" },
    { fails: true, http: true, native: false, restart: false, blocker: "none" },
    { fails: false, http: false, native: true, restart: false, blocker: "none" },
    { fails: false, http: false, native: true, restart: true, blocker: "none" },
    { fails: false, http: false, native: true, restart: false, blocker: "turn" },
    { fails: false, http: false, native: true, restart: false, blocker: "terminal" },
  ])("preserves existing chat, history and terminal (failure=$fails, HTTP=$http, native=$native, restart=$restart, blocker=$blocker)", async ({ fails, http, native, restart, blocker }) => {
    const directory = await mkdtemp(join(tmpdir(), "zeros-adoption-wire-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const root = join(directory, "checkout"), state = join(directory, "state"), tokenFile = join(directory, "worker-token");
    const nativeFixture = native ? await claudeNativeApi(() => blocker === "turn" ? [{ name: "Bash", input: {
      command: `printf ready > '${join(directory, "turn-entered")}'; cat '${join(directory, "turn-gate")}'`, description: "Hold the native fixture turn",
    } }] : []) : undefined;
    if (nativeFixture) cleanup.push(() => nativeFixture.close());
    if (blocker === "turn") execFileSync("mkfifo", [join(directory, "turn-gate")]);
    await mkdir(root); await mkdir(state);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "--initial-branch=main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
    await writeFile(join(root, ".gitignore"), ".env\n"); git("add", "."); git("commit", "-m", "fixture"); git("switch", "-c", "workspace/fixture");
    const creator = randomUUID(), org = randomUUID();
    await pool.query("INSERT INTO users(id,email,display_name) VALUES($1,$2,'Fixture')", [creator, `${creator}@example.test`]);
    await grantTestPro(pool, creator);
    await pool.query("INSERT INTO organizations(id,slug,name,created_by,is_personal,cloud_workspaces_allowed) VALUES($1,$2,'Fixture',$3,false,true)", [org, `org-${org}`, creator]);
    await pool.query("INSERT INTO organization_members(org_id,user_id,role) VALUES($1,$2,'owner')", [org, creator]);
    let store = new CloudV2Store(pool), handoffs = new RuntimeHandoffStore(pool);
    const environment = new CloudEnvironments(pool, { currentKeyVersion: 1, keys: { 1: randomBytes(32).toString("base64url") } },
      async () => ({ repositoryId: "42", assertCurrent: async () => {}, assertReadable: async () => {} }));
    await environment.patch(org, creator, "42", "fixture/repo", { expectedRevision: 0,
      variables: { APP_RUNTIME_FIXTURE: "synthetic-application-value" }, files: [{ path: ".env", content: "APP_RUNTIME_FIXTURE=synthetic-file-value\n" }] });
    const workspace = await store.createWorkspace({ id: randomUUID(), organizationId: org, creatorUserId: creator, name: "Runtime",
      repository: "fixture/repo", sourceRepositoryId: "42", branch: "workspace/fixture", baseBranch: "main", computerBuildId: null });
    await pool.query("UPDATE cloud_v2_workspaces SET boat_sandbox_id='bx_fixture1234' WHERE id=$1", [workspace.id]);
    const token = await store.rotateWorkerToken(workspace.id); await writeFile(tokenFile, token, { mode: 0o600 });
    const signer = new CloudV2WorkerSigner(generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"));
    let desired = "a".repeat(64), clock = 0, port = 0, candidateEntered!: () => void, releaseCandidate!: () => void;
    const entered = new Promise<void>(resolve => { candidateEntered = resolve; });
    const release = new Promise<void>(resolve => { releaseCandidate = resolve; });
    let finishing = false;
    const starts: Array<{ worker: CloudWorker; transport: HybridTransport; drivers: FakeDriver[]; statuses: string[]; nativeOpens: DriverOpen[]; nativeBindings: string[] }> = [];
    const setup = vi.fn(async () => 0);
    const mcpListings = vi.spyOn(CodeReviewAgentToolsCore.prototype, "listTools");
    const originalStart = InboundBridge.prototype.start;
    vi.spyOn(InboundBridge.prototype, "start").mockImplementation(async function (this: InboundBridge, receiver) {
      const address = await originalStart.call(this, receiver); port = address.port; return address;
    });
    const config = async () => ({ t: "config" as const, loginRevision: await store.loginRevision(workspace.id) ?? "0", runtimeUpdate: 1 as const,
      ...(http ? { promptOutbox: 1 as const } : {}),
      workspace: { id: workspace.id, organizationId: org, repository: "fixture/repo", checkoutPath: root, branch: "workspace/fixture", baseBranch: "main", setup: "printf fixture" },
      codeReview: { userId: creator }, agentInteractions: 1 as const,
      agents: native ? { claude: { apiKey: "offline-native-fixture-key" } }
        : { codex: { baseUrl: "http://127.0.0.1:1/v1", token: "synthetic-model-token", expiresAt: Date.now() + 60_000 } },
      environment: (await environment.resolve(workspace))!,
    });
    const start = (sha256: string, handoff?: { id: string; bootId: string; instanceId: string }) => {
      const statuses: string[] = [], drivers: FakeDriver[] = [], nativeOpens: DriverOpen[] = [], nativeBindings: string[] = [];
      const transport = new HybridTransport({ apiUrl, workspaceId: workspace.id, runtimeSha256: sha256, tokenFile, publicKeys: signer.publicKeys,
        port: 0, retryBaseMs: 10, retryMaxMs: 20, ...(handoff ? { runtimeHandoff: handoff } : {}), onStatus: value => statuses.push(value) });
      const worker = new CloudWorker({ directory: state, workspaceId: workspace.id, transport, homeDirectory: join(directory, "home"),
        runtimePermit: runtimePermit(state, transport.bootId), runtimeClock: () => clock,
        ...(handoff ? { runtimeResume: { instanceId: handoff.instanceId } } : {}),
        prepareCheckout: async () => ({ createdBranch: true }), setupRunner: setup, workspaceServices: { watch: false },
        drivers: nativeFixture ? { claude: () => {
          const driver = new ClaudeDriver({ executable: nativeFixture.executable, query: args => query({ ...args, options: {
            ...args.options, env: nativeFixture.env, spawnClaudeCodeProcess: nativeFixture.spawnClaudeCodeProcess, settingSources: [], strictMcpConfig: true,
          } }) });
          const open = driver.open.bind(driver);
          vi.spyOn(driver, "open").mockImplementation(async input => { nativeOpens.push(input); const result = await open(input); nativeBindings.push(result.nativeSessionId); return result; });
          return driver;
        } } : { codex: () => { const driver = new FakeDriver(); drivers.push(driver); return driver; } } });
      const item = { worker, transport, drivers, statuses, nativeOpens, nativeBindings }; starts.push(item);
      cleanup.push(() => worker.dispose()); worker.start(); return item;
    };
    const replacements = new Set<Promise<void>>();
    const compute = { execLong: vi.fn(async (_sandbox: string, command: string) => {
      if (command.includes("systemctl restart zeros-worker.service")) {
        const h = (await pool.query("SELECT * FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [workspace.id])).rows[0];
        const rollback = h.state === "rolling_back";
        const replacing = (async () => {
          if (!rollback) {
            candidateEntered(); await release;
            if (finishing) return;
            await readFile(join(state, "runtime-handoffs", `permit-${h.id}-${h.old_boot_id}`));
          }
          await starts.at(-1)!.worker.dispose();
          if (finishing) return;
          if (fails && !rollback) {
            await handoffs.environment(token, h.id, h.next_boot_id, { versionId: (await environment.resolve(workspace))!.versionId,
              sequence: 1, state: "failed", errorCode: "cloud_environment_seed_uncertain" });
          } else start(rollback ? h.previous_sha256 : h.target_sha256, { id: h.id, bootId: rollback ? h.rollback_boot_id : h.next_boot_id, instanceId: h.instance_id });
        })();
        replacements.add(replacing); void replacing.finally(() => replacements.delete(replacing)).catch(() => {});
      }
      return { exitCode: 0, stdout: command.includes("echo started") ? "started" : "", timedOut: false };
    }) };
    const controlPlanes: Array<{ adoption: RuntimeAdoption; server: ReturnType<typeof serve>; relay: CloudV2Relay }> = [];
    const serveControlPlane = async (listenPort = 0) => {
      const adoption = new RuntimeAdoption({ handoffs, store, compute, authorizeSource: async () => {},
        runtimeForWorkspace: async () => ({ sha256: desired, url: async () => "https://fixture.example.test/runtime.tar.gz" }) });
      cleanup.push(() => adoption.close());
      const app = new Hono(); app.onError((error, c) => c.json({ code: error instanceof HttpError ? error.code : "internal" }, error instanceof HttpError ? error.status : 500));
      app.route("/", createCloudV2WorkerRoutes({ store, runtimeSha256: desired, runtimeSha256ForWorkspace: async () => desired,
        runtimeUpdates: adoption, runtimeHandoffs: handoffs, promptOutbox: http, config, githubToken: async () => ({ token: "synthetic-github", expiresAt: Date.now() + 60_000 }),
        environmentReport: (value, boot, report) => environment.report(value, boot, report) }));
      const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: listenPort });
      await new Promise<void>(resolve => server.once("listening", resolve));
      cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
      const relay = new CloudV2Relay({ store, config, runtimeAdmission: handoffs, authorizeSource: async () => {},
        workerRoute: async () => {
          const route = (await store.workerRoute(workspace.id))!, handoff = await handoffs.route(workspace.id);
          return { ...route, bootId: handoff.blocked ? null : route.bootId, url: `http://127.0.0.1:${port}`, token: "synthetic-port-token" };
        }, mintWorkerToken: (id, boot) => signer.mint(id, boot), wake: async () => { throw new Error("Unexpected VM wake"); },
        answerOffline: async () => null, retryBaseMs: 10, retryMaxMs: 20, idleMs: 10 });
      server.on("upgrade", (req, socket, head) => { if (!relay.handleUpgrade(req, socket, head)) socket.destroy(); }); cleanup.push(() => relay.close());
      const instance = { adoption, server, relay }; controlPlanes.push(instance); return instance;
    };
    let controlPlane = await serveControlPlane();
    const apiPort = (controlPlane.server.address() as { port: number }).port;
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    settle.push(async () => {
      finishing = true; for (const cp of controlPlanes) cp.adoption.close(); releaseCandidate();
      await Promise.allSettled(replacements);
    });
    const connect = async () => {
      const issued = await store.issueToken({ workspaceId: workspace.id, kind: "connect", userId: creator, ttlMs: 60_000, wake: false });
      const socket = new WebSocket(`${apiUrl.replace("http:", "ws:")}/v2/cloud/workspaces/${workspace.id}/bridge`, ["zeros.cloud.v2", `ticket.${issued.token}`]);
      const frames: any[] = []; socket.on("message", raw => frames.push(JSON.parse(String(raw)))); cleanup.push(() => socket.terminate());
      await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
      const send = (type: string, fields: Record<string, unknown>) => { const frame = browserFrame(type, fields); socket.send(JSON.stringify(frame)); return frame.id; };
      const response = async (id: string) => { await expect.poll(() => frames.find(frame => frame.requestId === id), { timeout: native ? 10_000 : 5000 }).toBeDefined(); return frames.find(frame => frame.requestId === id); };
      return { socket, frames, send, response };
    };
    const first = start(desired); await expect.poll(() => first.statuses).toContain("connected");
    const initial = await connect(); await expect.poll(() => initial.frames.some(frame => frame.type === "ENGINE_READY")).toBe(true);
    const instance = initial.frames.find(frame => frame.type === "ENGINE_READY").instanceId;
    const key = `cloud://${org}/${workspace.id}`, agentId = native ? "claude" : "codex";
    await initial.response(initial.send("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: { id: "chat", folder: key, agentId, title: "Retained", createdAt: 100 } } }));
    const opened = await initial.response(initial.send("AGENT_NEW_SESSION", { agentId, chatId: "chat", cwd: key, workspaceId: workspace.id }));
    const executionId = opened.session.sessionId;
    const prompt = { agentId, chatId: "chat", sessionId: executionId, executionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "before adoption" }] };
    const beforePrompt = initial.send("AGENT_PROMPT", prompt);
    if (!native) { await expect.poll(() => first.drivers[0]?.prompts.length).toBe(1); first.drivers[0]!.complete(); }
    if (blocker === "turn") await expect.poll(() => readFile(join(directory, "turn-entered"), "utf8").catch(() => ""), { timeout: 10_000 }).toBe("ready");
    else { expect((await initial.response(beforePrompt)).type).toBe("AGENT_PROMPT_COMPLETE"); await first.worker.flush(); }
    if (blocker === "terminal") {
      initial.send("PTY_CREATE", { sessionId: "held-terminal", workspaceId: workspace.id, cwd: root });
      await expect.poll(() => initial.frames.some(frame => frame.type === "PTY_CREATED" && frame.sessionId === "held-terminal")).toBe(true);
    }
    await expect.poll(() => setup.mock.calls.length).toBe(1);
    desired = "b".repeat(64); clock = 31_000;
    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(first.worker.runtimeCensus.clients).toBe(true);
    expect((await pool.query("SELECT id FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
    expect(compute.execLong).not.toHaveBeenCalled();
    initial.socket.close(); await expect.poll(() => first.worker.runtimeCensus.clients).toBe(false);
    if (blocker !== "none") {
      await new Promise(resolve => setTimeout(resolve, 1100)); clock += 31_000;
      await new Promise(resolve => setTimeout(resolve, 1100));
      expect(first.worker.runtimeCensus[blocker === "turn" ? "agents" : "terminals"]).toBe(true);
      expect(compute.execLong).not.toHaveBeenCalled();
      expect((await pool.query("SELECT id FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [workspace.id])).rowCount).toBe(0);
      if (blocker === "turn") { await writeFile(join(directory, "turn-gate"), "done\n"); await expect.poll(() => first.worker.runtimeCensus.agents, { timeout: 10_000 }).toBe(false); }
      else {
        const release = await connect(); release.send("PTY_KILL", { sessionId: "held-terminal" });
        await expect.poll(() => first.worker.runtimeCensus.terminals).toBe(false);
        release.socket.close(); await expect.poll(() => first.worker.runtimeCensus.clients).toBe(false);
      }
    }
    if (restart) {
      controlPlane.adoption.close(); await controlPlane.relay.close();
      await new Promise<void>(resolve => { controlPlane.server.closeAllConnections(); controlPlane.server.close(() => resolve()); });
      await first.transport.send({ t: "idle", idle: true });
      await expect.poll(() => first.statuses).toContain("disconnected");
      store = new CloudV2Store(pool); handoffs = new RuntimeHandoffStore(pool);
      controlPlane = await serveControlPlane(apiPort);
      await expect.poll(() => first.statuses.filter(status => status === "connected").length).toBeGreaterThan(1);
    }
    const before = await store.get(workspace.id, creator);
    if (native) await expect.poll(() => first.worker.runtimeCensus, { timeout: 5000 }).toEqual({ clients: false, requests: false, agents: false, terminals: false,
      setup: false, checkout: false, configuration: false, prompts: false, attachments: false, storage: false, tools: false });
    await new Promise(resolve => setTimeout(resolve, 1200)); clock += 31_000;
    let handoffTimer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise((_, reject) => {
      handoffTimer = setTimeout(() => reject(new Error("No runtime handoff after a completed native turn")), 5000); handoffTimer.unref();
    })]); } finally { clearTimeout(handoffTimer); }
    const successor = await connect();
    const beforeResumeRequests = nativeFixture?.requests.length ?? 0;
    const beforeResumeListings = mcpListings.mock.calls.length;
    const afterMessage = randomUUID();
    const afterPrompt = http ? undefined : successor.send("AGENT_PROMPT", { ...prompt, userMessageId: afterMessage, prompt: [{ type: "text", text: "after adoption" }] });
    if (http) {
      await store.prompts.enqueue(workspace.id, creator, { chatId: "chat", userMessageId: afterMessage, agentId: "codex", startedAt: Date.now(), prompt: [{ type: "text", text: "after adoption" }] });
      expect(await store.prompts.pull(token, first.transport.bootId, [])).toMatchObject({ prompts: [] });
      expect(first.drivers[0]!.prompts).toHaveLength(1);
    }
    expect(successor.frames).toEqual([]); expect((await store.get(workspace.id, creator)).state).toBe("running");
    releaseCandidate();
    await expect.poll(async () => (await pool.query("SELECT state FROM cloud_worker_runtime_handoffs WHERE workspace_id=$1", [workspace.id])).rows[0]?.state,
      { timeout: 8000 }).toBe(fails ? "rolled_back" : "succeeded");
    const next = starts.at(-1)!;
    if (!native) {
      await expect.poll(() => next.drivers[0]?.prompts.length, { timeout: 5000 }).toBe(1);
      expect(next.drivers[0]!.opened?.nativeSessionId).toBe(`native-${executionId}`);
      next.drivers[0]!.complete();
    } else {
      await expect.poll(() => next.nativeOpens.length, { timeout: 5000 }).toBe(1);
      expect(next.nativeOpens[0].nativeSessionId).toBe(first.nativeBindings[0]);
      expect(beforeResumeListings).toBeGreaterThan(0);
    }
    if (afterPrompt) expect((await successor.response(afterPrompt)).type).toBe("AGENT_PROMPT_COMPLETE");
    else await expect.poll(async () => (await pool.query("SELECT state FROM cloud_v2_prompt_outbox WHERE workspace_id=$1 AND user_message_id=$2", [workspace.id, afterMessage])).rows[0]?.state).toBe("completed");
    if (native) {
      expect(next.nativeBindings[0]).toBe(first.nativeBindings[0]);
      expect(nativeFixture!.requests.length).toBeGreaterThan(beforeResumeRequests);
      expect(mcpListings.mock.calls.length).toBeGreaterThan(beforeResumeListings);
    }
    expect(successor.frames.find(frame => frame.type === "ENGINE_READY")).toMatchObject({ instanceId: instance });
    const history = await successor.response(successor.send("WORKSPACE_REQUEST", { op: "messages.window", params: { chatId: "chat" } }));
    expect(history.type).toBe("WORKSPACE_RESPONSE"); expect(JSON.stringify(history)).toContain("after adoption");
    successor.send("PTY_CREATE", { sessionId: "after-update", workspaceId: workspace.id, cwd: root });
    await expect.poll(() => successor.frames.some(frame => frame.type === "PTY_CREATED" && frame.sessionId === "after-update")).toBe(true);
    successor.send("PTY_WRITE", { sessionId: "after-update", data: "printf 'runtime-terminal-ok\\n'\r" });
    await expect.poll(() => JSON.stringify(successor.frames).includes("runtime-terminal-ok")).toBe(true);
    successor.send("PTY_KILL", { sessionId: "after-update" });
    expect(successor.frames.filter(frame => frame.type === "AGENT_ERROR")).toEqual([]);
    if (native) expect(successor.frames.flatMap(frame => frame.type === "AGENT_SESSION_UPDATE" && frame.update?.sessionUpdate === "error_notice" ? [frame] : [])).toEqual([]);
    expect(next.statuses).not.toContain("unauthorized"); expect(setup).toHaveBeenCalledOnce();
    expect((await store.get(workspace.id, creator)).state).toBe(before.state);
    expect(await handoffs.runtime(token, next.transport.bootId)).toBe((fails ? "a" : "b").repeat(64));
    expect(await readFile(join(root, ".env"), "utf8")).toBe("APP_RUNTIME_FIXTURE=synthetic-file-value\n");
    await Promise.all(replacements);
  }, 35_000);
});
