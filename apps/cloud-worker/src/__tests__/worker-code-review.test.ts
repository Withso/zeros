import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeMessage } from "@zeros/protocol/messages";
import type { CodeReviewListResult, CodeReviewThread } from "@zeros/protocol/code-review";
import { CloudWorker } from "../worker";
import { commandRunner } from "../workspace/commands";
import { CLIENT_A, CLIENT_B, WORKSPACE_ID, FakeDriver, FakeRelay, browserFrame, config } from "./worker-fixtures";
import { WorkerCodeReview } from "../workspace/code-review";
import { WorkspaceToolsMcp } from "../mcp/workspace-tools";
import { WorkspaceService } from "../workspace/service";
import type { Agents } from "../agents";
import { SessionStore } from "../sessions/session-store";
// Test-only: execute the independently deployed checkpoint scripts against the
// real VM store, so adding state cannot silently escape restore coverage.
import { checkpointArchiveSteps, checkpointRestoreSteps, CLOUD_V2_WORKER_STATE, parseCheckpointResult, parseRestoreResult } from "../../../control-plane/src/cloud/checkpoint";

const execute = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const author = { userId: "44444444-4444-4444-8444-444444444444", userName: "Fixture reviewer" };
const input = { workspaceId: WORKSPACE_ID, anchor: { path: "example.ts", side: "new" as const, startLine: 1, endLine: 1, revision: "sha256:original" }, body: "Please handle this case", requestId: "human-create" };

async function fixture(enabled = true) {
  const directory = await mkdtemp(join(tmpdir(), "zeros-worker-review-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home"), root = join(home, "fixture", "repo"), state = join(home, CLOUD_V2_WORKER_STATE);
  await mkdir(root, { recursive: true });
  await execute("git", ["init", "-q", "-b", "main"], { cwd: root });
  await writeFile(join(root, "example.ts"), "original\n");
  const configuration = { ...config, workspace: { ...config.workspace, checkoutPath: root },
    ...(enabled ? { codeReview: author } : {}),
    agents: { ...config.agents, claude: { oauthToken: "offline-placeholder" }, cursor: { apiKey: "offline-placeholder" } } };
  const boot = async (location = { root, home, state }) => {
    const relay = new FakeRelay(), drivers: FakeDriver[] = [];
    const driver = () => { const result = new FakeDriver(); drivers.push(result); return result; };
    const worker = new CloudWorker({ directory: location.state, homeDirectory: location.home, transport: relay, prepareCheckout: async () => {},
      drivers: { codex: driver, claude: driver, cursor: driver },
      workspaceServices: { watch: false, run: commandRunner(location.root), lookupPr: async () => ({ prNumber: null, prState: null, prUrl: null }) } });
    cleanups.push(() => worker.dispose());
    worker.start(); await relay.receive({ ...configuration, workspace: { ...configuration.workspace, checkoutPath: location.root } });
    await relay.receive({ t: "open", clientId: CLIENT_A }); await relay.receive({ t: "open", clientId: CLIENT_B });
    const op = async (op: string, params: Record<string, unknown> = {}, clientId = CLIENT_A) => {
      const message = browserFrame("WORKSPACE_REQUEST", { op, params });
      await relay.request(clientId, message);
      const response = relay.response(message.id) as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" | "WORKSPACE_ERROR" }> | undefined;
      expect(response, "the configured worker must answer review operations").toBeDefined();
      return response!;
    };
    return { relay, drivers, worker, op };
  };
  return { directory, root, home, state, configuration, boot, ...await boot() };
}

const result = <T>(response: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["op"]>>): T => {
  expect(response.type).toBe("WORKSPACE_RESPONSE");
  return (response as Extract<BridgeMessage, { type: "WORKSPACE_RESPONSE" }>).result as T;
};

describe("cloud private review comments", () => {
  it("keeps an older control plane unavailable without pretending comments are empty", async () => {
    const f = await fixture(false);
    expect(f.relay.bridge("ENGINE_READY")[0].frame).not.toHaveProperty("capabilities", expect.arrayContaining(["code-review-v1"]));
    expect(await f.op("codeReview.list", { workspaceId: WORKSPACE_ID })).toMatchObject({ type: "WORKSPACE_ERROR", code: "CLOUD_V2_UNSUPPORTED" });
  });

  it("shares human comments, idempotent retries and versions across devices and restart", async () => {
    const f = await fixture();
    expect(f.relay.bridge("ENGINE_READY")[0]?.frame).toMatchObject({ capabilities: expect.arrayContaining(["code-review-v1"]) });
    const created = result<CodeReviewThread>(await f.op("codeReview.create", input));
    expect(created.comments[0].author).toEqual({ id: `human:${author.userId}`, name: author.userName, kind: "human" });
    const reply = result<CodeReviewThread>(await f.op("codeReview.reply", { workspaceId: WORKSPACE_ID, threadId: created.id, body: "Confirmed", requestId: "reply" }, CLIENT_B));
    expect(reply.comments.map(comment => comment.body)).toEqual([input.body, "Confirmed"]);
    expect(result<CodeReviewThread>(await f.op("codeReview.create", input))).toEqual(reply);
    expect(await f.op("codeReview.setResolved", { workspaceId: WORKSPACE_ID, threadId: created.id, resolved: true, expectedVersion: created.version })).toMatchObject({ code: "CODE_REVIEW_STALE" });
    const resolved = result<CodeReviewThread>(await f.op("codeReview.setResolved", { workspaceId: WORKSPACE_ID, threadId: created.id, resolved: true, expectedVersion: reply.version, requestId: "resolve" }));
    expect(f.relay.bridge("DB_CHANGED").some(({ frame }) => frame.type === "DB_CHANGED" && frame.kinds.includes("codeReview"))).toBe(true);
    await f.worker.dispose();
    const restarted = await f.boot();
    const read = result<CodeReviewListResult>(await restarted.op("codeReview.list", { workspaceId: WORKSPACE_ID }));
    expect(read.threads).toEqual([resolved]); expect(read.viewerActorId).toBe(`human:${author.userId}`);
  });

  it("updates the connected capability on negotiated config changes while retaining private data", async () => {
    const f = await fixture(false);
    await f.relay.receive({ ...f.configuration, codeReview: author, loginRevision: "1" });
    expect(f.relay.bridge("ENGINE_READY").at(-1)?.frame).toMatchObject({ capabilities: expect.arrayContaining(["code-review-v1"]) });
    const thread = result<CodeReviewThread>(await f.op("codeReview.create", input));
    await f.relay.receive({ ...f.configuration, loginRevision: "2" });
    expect(f.relay.bridge("ENGINE_READY").at(-1)?.frame).not.toHaveProperty("capabilities", expect.arrayContaining(["code-review-v1"]));
    expect(await f.op("codeReview.list", { workspaceId: WORKSPACE_ID })).toMatchObject({ code: "CLOUD_V2_UNSUPPORTED" });
    await f.relay.receive({ ...f.configuration, codeReview: author, loginRevision: "3" });
    expect(result<CodeReviewListResult>(await f.op("codeReview.list", { workspaceId: WORKSPACE_ID })).threads).toEqual([thread]);
  });

  it.each([false, true])("retires native review grants across disable and re-enable (pending=%s)", async pending => {
    const f = await fixture();
    let release!: () => void, waiting = false;
    const held = new Promise<void>(resolve => { release = resolve; }), original = WorkspaceToolsMcp.prototype.admit;
    if (pending) vi.spyOn(WorkspaceToolsMcp.prototype, "admit").mockImplementationOnce(async function (this: WorkspaceToolsMcp, ...args) {
      waiting = true; await held; return original.apply(this, args);
    });
    const message = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "review-toggle", cwd: f.root, workspaceId: WORKSPACE_ID });
    const opening = f.relay.request(CLIENT_A, message);
    try {
      if (pending) await expect.poll(() => waiting).toBe(true); else await opening;
      const { codeReview: _review, ...legacy } = f.configuration;
      await f.relay.receive({ ...legacy, loginRevision: "1" });
      await f.relay.receive({ ...f.configuration, loginRevision: "2" });
      if (pending) {
        release(); await opening;
        expect(f.relay.response(message.id)?.type).toBe("AGENT_ERROR");
      }
      await f.relay.request(CLIENT_A, { ...message, id: randomUUID() });
      expect(f.drivers.length).toBe(2);
      const registration = f.drivers[1].opened!.mcpServers!.zeros_workspace;
      const client = new Client({ name: "review-toggle-fixture", version: "1" }); cleanups.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
      expect((await client.listTools()).tools).toHaveLength(4);
    } finally { release(); await opening; }
  });

  it("fences pending review admission before a disabling configuration waits on other services", async () => {
    const f = await fixture();
    let releaseAdmission!: () => void, releaseConfig!: () => void, waiting = false, configuring = false, admitted = false;
    const admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const configuration = new Promise<void>(resolve => { releaseConfig = resolve; });
    const admit = WorkspaceToolsMcp.prototype.admit, configure = WorkspaceService.prototype.configure;
    vi.spyOn(WorkspaceToolsMcp.prototype, "admit").mockImplementationOnce(async function (this: WorkspaceToolsMcp, ...args) {
      waiting = true; await admission; const grant = await admit.apply(this, args); admitted = true; return grant;
    });
    vi.spyOn(WorkspaceService.prototype, "configure").mockImplementationOnce(async function (this: WorkspaceService, ...args) {
      configuring = true; await configuration; return configure.apply(this, args);
    });
    const message = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "review-config-pending", cwd: f.root, workspaceId: WORKSPACE_ID });
    const opening = f.relay.request(CLIENT_A, message);
    await expect.poll(() => waiting).toBe(true);
    const { codeReview: _review, ...disabled } = f.configuration;
    const changing = f.relay.receive({ ...disabled, loginRevision: "1", workspace: { ...disabled.workspace, baseBranch: "release" } });
    try {
      await expect.poll(() => configuring).toBe(true);
      releaseAdmission(); await opening;
      expect(admitted).toBe(false);
      expect(f.relay.response(message.id)?.type).toBe("AGENT_ERROR");
    } finally { releaseAdmission(); releaseConfig(); await Promise.allSettled([opening, changing]); }
  });

  it("closes the store before Stop acknowledgement and restores anchors, replies, versions and receipts through the real encrypted checkpoint", async () => {
    const f = await fixture(), closed = vi.spyOn(WorkerCodeReview.prototype, "close");
    await execute("git", ["add", "example.ts"], { cwd: f.root });
    await execute("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "base"], { cwd: f.root });
    await execute("git", ["switch", "-qc", config.workspace.branch], { cwd: f.root });
    const origin = join(f.directory, "origin.git");
    await execute("git", ["clone", "-q", "--bare", f.root, origin]);
    const first = result<CodeReviewThread>(await f.op("codeReview.create", input));
    const reply = result<CodeReviewThread>(await f.op("codeReview.reply", { workspaceId: WORKSPACE_ID, threadId: first.id, body: "A retained reply", requestId: "reply-before-checkpoint" }));
    const resolved = result<CodeReviewThread>(await f.op("codeReview.setResolved", { workspaceId: WORKSPACE_ID, threadId: first.id, resolved: true, expectedVersion: reply.version }));
    const send = f.relay.send.bind(f.relay);
    f.relay.send = async frame => { if (frame.t === "stop-ack") expect(closed).toHaveBeenCalled(); return send(frame); };
    const stopId = randomUUID(); await f.relay.receive({ t: "stop", id: stopId });
    expect(f.relay.frames).toContainEqual({ t: "stop-ack", id: stopId });
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const key = randomBytes(32), archive = join(f.directory, "review-checkpoint.zck");
    const run = (script: string[]) => {
      const output = spawnSync("bash", ["-c", script.join("\n")], { encoding: "utf8", timeout: 20_000,
        env: { PATH: process.env.PATH, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
          GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
      return { status: output.status, stdout: output.stdout };
    };
    const saved = run([...checkpointArchiveSteps({ checkoutPath: f.root, home: f.home, baseBranch: "main", key }),
      `cp "$work/checkpoint.zck" ${quote(archive)}`, 'report "zeros-checkpoint-saved bytes=$bytes sha256=$sha"']);
    expect(saved.status).toBe(0); expect(parseCheckpointResult(saved.stdout).ok).toBe(true);
    const { home, root, state } = f;
    const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
    await f.worker.dispose(); await rm(f.home, { recursive: true, force: true });
    await mkdir(join(home, "fixture"), { recursive: true }); await execute("git", ["clone", "-q", origin, root]);
    const restored = run([...checkpointRestoreSteps({ checkoutPath: root, home, key, sha256 }, [`cp ${quote(archive)} "$work/checkpoint.zck"`]), "report zeros-checkpoint-restored"]);
    expect(restored.status).toBe(0); expect(parseRestoreResult(restored.stdout)).toEqual({ ok: true });
    const replacement = await f.boot({ root, home, state });
    expect(result<CodeReviewListResult>(await replacement.op("codeReview.list", { workspaceId: WORKSPACE_ID })).threads).toEqual([resolved]);
    expect(result<CodeReviewThread>(await replacement.op("codeReview.create", input))).toEqual(resolved);
    expect(await replacement.op("codeReview.setResolved", { workspaceId: WORKSPACE_ID, threadId: first.id, resolved: false, expectedVersion: first.version }))
      .toMatchObject({ code: "CODE_REVIEW_STALE" });
  }, 30_000);

  it.each(["stop", "dispose"] as const)("fences an in-flight product grant before %s waits on other services", async mode => {
    const f = await fixture();
    let releaseAdmission!: () => void, releaseShutdown!: () => void, waiting = false, shuttingDown = false, admitted = false;
    const admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
    const shutdown = new Promise<void>(resolve => { releaseShutdown = resolve; });
    const original = WorkspaceToolsMcp.prototype.admit;
    vi.spyOn(WorkspaceToolsMcp.prototype, "admit").mockImplementationOnce(async function (this: WorkspaceToolsMcp, ...args) {
      waiting = true; await admission; const grant = await original.apply(this, args); admitted = true; return grant;
    });
    const method = mode === "stop" ? "stopAttachmentTransfers" : "dispose", close = WorkspaceService.prototype[method];
    vi.spyOn(WorkspaceService.prototype, method).mockImplementationOnce(async function (this: WorkspaceService) {
      shuttingDown = true; await shutdown; return close.call(this);
    });
    await f.op("chats.upsert", { chat: { id: "opening-review", folder: f.root, agentId: "codex", title: "Review", createdAt: 1 } });
    const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "opening-review", cwd: f.root, workspaceId: WORKSPACE_ID });
    const opening = f.relay.request(CLIENT_A, open);
    await expect.poll(() => waiting).toBe(true);
    const stopping = mode === "stop" ? f.relay.receive({ t: "stop", id: randomUUID() }) : f.worker.dispose();
    try {
      await expect.poll(() => shuttingDown).toBe(true);
      releaseAdmission(); await opening;
      expect(admitted).toBe(false);
    } finally { releaseAdmission(); releaseShutdown(); await Promise.allSettled([opening, stopping]); }
  });

  it("accepts refreshed credentials to retry a stopped mirror without reopening review storage", async () => {
    const f = await fixture();
    const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "review-stop-retry", cwd: f.root, workspaceId: WORKSPACE_ID });
    await f.relay.request(CLIENT_A, open);
    const created = f.relay.response(open.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    await f.relay.request(CLIENT_A, browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId: created.session.sessionId,
      userMessageId: randomUUID(), prompt: [{ type: "text", text: "Review" }] }));
    await expect.poll(() => f.drivers[0].prompts.length).toBe(1);
    await f.worker.flush();
    const send = f.relay.send.bind(f.relay);
    f.relay.send = async frame => frame.t === "history" ? false : send(frame);
    f.drivers[0].emit({ sessionUpdate: "agent_message_chunk", messageId: "final-review", content: { type: "text", text: "Durable review conclusion" } });
    await expect(f.relay.receive({ t: "stop", id: randomUUID() })).rejects.toThrow("History mirror is unavailable");
    f.relay.send = send;
    await f.relay.receive({ ...f.configuration, loginRevision: "1" });
    expect((f.worker as unknown as { reviews: WorkerCodeReview }).reviews.enabled).toBe(false);
    const id = randomUUID(); await f.relay.receive({ t: "stop", id });
    expect(f.relay.frames.at(-1)).toEqual({ t: "stop-ack", id });
    expect(f.drivers.length).toBe(1);
    expect(f.relay.frames.some(frame => frame.t === "history" && frame.messages?.rows.some(row => row.payload.includes("Durable review conclusion")))).toBe(true);
  });

  it.each(["codex", "claude", "cursor"] as const)("lets %s read and reply through its actual MCP grant, then revokes it on Stop", async agentId => {
    const f = await fixture();
    const thread = result<CodeReviewThread>(await f.op("codeReview.create", input));
    await f.op("chats.upsert", { chat: { id: "review-chat", folder: f.root, agentId, title: "Review", createdAt: 1 } });
    const open = browserFrame("AGENT_NEW_SESSION", { agentId, chatId: "review-chat", cwd: f.root, workspaceId: WORKSPACE_ID });
    await f.relay.request(CLIENT_A, open);
    const session = f.relay.response(open.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>;
    expect(session?.type).toBe("AGENT_SESSION_CREATED");
    const prompt = browserFrame("AGENT_PROMPT", { agentId, sessionId: session.session.sessionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "Read the private review comments" }] });
    await f.relay.request(CLIENT_A, prompt);
    await expect.poll(() => f.drivers[0].prompts.length).toBe(1);
    const registration = f.drivers[0].opened?.mcpServers?.zeros_workspace;
    expect(registration).toBeDefined();
    const client = new Client({ name: "cloud-review-fixture", version: "1" });
    cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(registration!.url), { requestInit: { headers: registration!.headers } }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["code_review_list", "code_review_create", "code_review_reply", "code_review_set_resolved"]);
    const read = await client.callTool({ name: "code_review_list", arguments: {} });
    expect(read.content).toEqual([{ type: "text", text: expect.stringContaining(input.body) }]);
    const replied = await client.callTool({ name: "code_review_reply", arguments: { threadId: thread.id, body: "Agent reply", requestId: "agent-reply" } });
    expect(replied.isError).not.toBe(true);
    const updated = result<CodeReviewListResult>(await f.op("codeReview.list", { workspaceId: WORKSPACE_ID })).threads[0];
    expect(updated.comments.at(-1)?.author).toMatchObject({ id: `agent:${agentId}:review-chat`, kind: "agent", provider: agentId });
    const stopped = browserFrame("AGENT_CANCEL", { agentId, sessionId: session.session.sessionId });
    await f.relay.request(CLIENT_A, stopped);
    await expect(client.callTool({ name: "code_review_reply", arguments: { threadId: thread.id, body: "Late reply" } })).rejects.toThrow();
    expect(result<CodeReviewListResult>(await f.op("codeReview.list", { workspaceId: WORKSPACE_ID })).threads[0].comments).toHaveLength(2);
    await f.relay.request(CLIENT_A, { ...prompt, id: randomUUID(), userMessageId: randomUUID() });
    await expect.poll(() => f.drivers[1]?.prompts.length).toBe(1);
    const replacement = f.drivers[1].opened!.mcpServers!.zeros_workspace;
    expect(replacement.headers?.Authorization === registration!.headers?.Authorization).toBe(false);
    const resumed = new Client({ name: "resumed-review-fixture", version: "1" }); cleanups.push(() => resumed.close());
    await resumed.connect(new StreamableHTTPClientTransport(new URL(replacement.url), { requestInit: { headers: replacement.headers } }));
    expect((await resumed.callTool({ name: "code_review_list", arguments: {} })).isError).not.toBe(true);
  });

  it("revokes an idle execution's review grant before an HTTP Stop receipt is durable", async () => {
    const f = await fixture(), chatId = "idle-review";
    const opening = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId, cwd: f.root, workspaceId: WORKSPACE_ID });
    await f.relay.request(CLIENT_A, opening);
    const registration = f.drivers[0].opened!.mcpServers!.zeros_workspace;
    const client = new Client({ name: "idle-review-fixture", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
    let release!: () => void, entered = false;
    const held = new Promise<void>(resolve => { release = resolve; }), original = SessionStore.prototype.stopOutbox;
    vi.spyOn(SessionStore.prototype, "stopOutbox").mockImplementationOnce(async function (this: SessionStore, ...args) {
      entered = true; await held; return original.apply(this, args);
    });
    const stopping = (f.worker as unknown as { agents: Agents }).agents.stopOutbox(chatId, "1");
    try {
      await expect.poll(() => entered).toBe(true);
      expect(await client.listTools().then(() => true, () => false)).toBe(false);
    } finally { release(); await stopping; }
    await f.relay.request(CLIENT_A, { ...opening, id: randomUUID() });
    expect(f.drivers.length).toBe(2);
  });

  it("fences a pending idle review grant when an HTTP Stop advances its epoch", async () => {
    const f = await fixture(), chatId = "pending-review";
    let release!: () => void, waiting = false, admitted = false;
    const held = new Promise<void>(resolve => { release = resolve; }), original = WorkspaceToolsMcp.prototype.admit;
    vi.spyOn(WorkspaceToolsMcp.prototype, "admit").mockImplementationOnce(async function (this: WorkspaceToolsMcp, ...args) {
      waiting = true; await held; const grant = await original.apply(this, args); admitted = true; return grant;
    });
    const message = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId, cwd: f.root, workspaceId: WORKSPACE_ID });
    const opening = f.relay.request(CLIENT_A, message);
    try {
      await expect.poll(() => waiting).toBe(true);
      await (f.worker as unknown as { agents: Agents }).agents.stopOutbox(chatId, "1");
      release(); await opening;
      expect(admitted).toBe(false);
      expect(f.relay.response(message.id)?.type).toBe("AGENT_ERROR");
    } finally { release(); await opening; }
  });

  it("keeps a newer active epoch's review grant when an older HTTP Stop arrives", async () => {
    const f = await fixture(), chatId = "newer-review", userMessageId = randomUUID();
    const { agents, store } = f.worker as unknown as { agents: Agents; store: SessionStore };
    agents.setOutboxDispatch(async () => true);
    const entry = await agents.receiveOutbox({ deliveryId: randomUUID(),
      receipt: { workspaceId: WORKSPACE_ID, chatId, userMessageId, epoch: "2", sequence: "1", acceptedAt: new Date(0).toISOString(), workspaceState: "running" },
      payload: { chatId, userMessageId, agentId: "codex", startedAt: 1, prompt: [{ type: "text", text: "Review" }] } });
    await store.acknowledgeOutbox(chatId, entry.requestId, "inboxed"); agents.resumeOutbox(chatId);
    await expect.poll(() => f.drivers[0]?.prompts.length).toBe(1);
    const registration = f.drivers[0].opened!.mcpServers!.zeros_workspace;
    const client = new Client({ name: "newer-review-fixture", version: "1" }); cleanups.push(() => client.close());
    await client.connect(new StreamableHTTPClientTransport(new URL(registration.url), { requestInit: { headers: registration.headers } }));
    await agents.stopOutbox(chatId, "1");
    expect((await client.listTools()).tools).toHaveLength(4);
    expect(f.drivers[0].interrupts).toBe(0);
  });
});
