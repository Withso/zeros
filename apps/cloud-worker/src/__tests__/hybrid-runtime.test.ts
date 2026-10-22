import { generateKeyPairSync, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { CloudWorker } from "../worker";
import { InboundBridge } from "../inbound-bridge";
import { HybridTransport } from "../hybrid-transport";
import { FakeDriver, WORKSPACE_ID, browserFrame, config } from "./worker-fixtures";
// Test-only cross-deploy composition: both replicas use the real dialer and the
// worker uses its real listener, routing, turn lifecycle and HTTP mirror.
import { CloudV2Relay, CLOUD_V2_BRIDGE_PROTOCOL } from "../../../control-plane/src/cloud/relay";
import { CloudV2WorkerSigner } from "../../../control-plane/src/cloud/worker-auth";
import { newCloudV2Token } from "../../../control-plane/src/cloud/tokens";
import type { CloudV2Workspace } from "../../../control-plane/src/cloud/store";

it("serves two independent CP replicas, broadcasts a shared turn, and flushes HTTPS history before Stop ack", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hybrid-runtime-")), tokenFile = join(directory, "token");
  await writeFile(tokenFile, "synthetic-worker-credential", { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519"), signer = new CloudV2WorkerSigner(keys.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
  let workerPort = 0, bootId = "", blocked = false, release!: () => void;
  let historyGate: Promise<void> | undefined;
  const rows = new Map<string, { payload: string }>();
  const posts: Array<{ path: string; body: any }> = [];
  const api = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer synthetic-worker-credential") { response.writeHead(401).end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const path = request.url!.split("/").at(-1)!; posts.push({ path, body });
    let reply;
    if (path === "hello") { bootId = body.bootId; reply = { config }; }
    else if (path === "config") reply = { config };
    else if (path === "activity") reply = { state: "running", loginRevision: "0" };
    else if (path === "history") {
      if (historyGate) { blocked = true; await historyGate; }
      for (const row of body.messages?.rows ?? []) rows.set(row.msgId, row);
      reply = { sequence: body.sequence };
    } else reply = { token: "synthetic-github-token", expiresAt: Date.now() + 60_000 };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const listen = InboundBridge.prototype.start;
  vi.spyOn(InboundBridge.prototype, "start").mockImplementationOnce(async function (this: InboundBridge, receive) {
    const address = await listen.call(this, receive); workerPort = address.port; return address;
  });
  const transport = new HybridTransport({ apiUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, workspaceId: WORKSPACE_ID,
    runtimeSha256: "a".repeat(64), tokenFile, publicKeys: signer.publicKeys, port: 0 });
  const driver = new FakeDriver();
  const worker = new CloudWorker({ transport, directory: join(directory, "state"), workspaceId: WORKSPACE_ID,
    prepareCheckout: async () => {}, drivers: { codex: () => driver } });
  const servers: Server[] = [], relays: CloudV2Relay[] = [], apps: WebSocket[] = [];
  const workspace: CloudV2Workspace = { id: WORKSPACE_ID, creatorUserId: WORKSPACE_ID, organizationId: config.workspace.organizationId,
    repository: config.workspace.repository, branch: config.workspace.branch, baseBranch: "main", name: "Fixture", state: "running",
    boatSandboxId: "bx_fixture", computerBuildId: null, activeAt: null, archivedAt: null, errorCode: null,
    createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() };
  try {
    worker.start();
    await expect.poll(() => posts.some(post => post.path === "activity")).toBe(true);
    const frames: any[][] = [];
    for (let replica = 0; replica < 2; replica++) {
      const ticket = newCloudV2Token("connect").token;
      const relay = new CloudV2Relay({ store: {
        consumeConnectTicket: async value => value === ticket ? { userId: WORKSPACE_ID, accessEpoch: "0", wake: true } : null,
        get: async () => workspace, accessEpoch: async () => "0", loginRevision: async () => "0",
      }, config: async () => config, wake: async () => {}, answerOffline: async () => null,
      workerRoute: async () => ({ workspace, accessEpoch: "0", url: `http://127.0.0.1:${workerPort}`, token: "synthetic-private-route-token", bootId }),
      mintWorkerToken: (id, boot) => signer.mint(id, boot), retryBaseMs: 10 });
      relays.push(relay);
      const server = createServer(); servers.push(server);
      server.on("upgrade", (request, socket, head) => { if (!relay.handleUpgrade(request, socket, head)) socket.destroy(); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const app = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/v2/cloud/workspaces/${WORKSPACE_ID}/bridge`, [CLOUD_V2_BRIDGE_PROTOCOL, `ticket.${ticket}`]);
      apps.push(app); const received: any[] = []; frames.push(received);
      app.on("message", raw => received.push(JSON.parse(String(raw))));
      await expect.poll(() => received.some(frame => frame.type === "ENGINE_READY")).toBe(true);
    }
    const send = (replica: number, frame: unknown) => apps[replica]!.send(JSON.stringify(frame));
    const response = (replica: number, requestId: string) => frames[replica]!.find(frame => frame.requestId === requestId);
    const requests = [0, 1].map(() => browserFrame("WORKSPACE_REQUEST", { op: "workspace.list" }));
    for (const replica of [0, 1]) send(replica, requests[replica]);
    for (const replica of [0, 1]) {
      await expect.poll(() => response(replica, requests[replica]!.id)).toMatchObject({ type: "WORKSPACE_RESPONSE" });
      expect(response(1 - replica, requests[replica]!.id)).toBeUndefined();
    }
    const upsert = browserFrame("WORKSPACE_REQUEST", { op: "chats.upsert", params: { chat: {
      id: "shared-chat", folder: config.workspace.checkoutPath, agentId: "codex", createdAt: 1, title: "Fixture",
    } } });
    send(0, upsert); await expect.poll(() => response(0, upsert.id)?.result).toEqual({ ok: true });
    const open = browserFrame("AGENT_NEW_SESSION", { agentId: "codex", chatId: "shared-chat", cwd: config.workspace.checkoutPath, workspaceId: WORKSPACE_ID });
    send(0, open); await expect.poll(() => response(0, open.id)?.type).toBe("AGENT_SESSION_CREATED");
    const sessionId = response(0, open.id).session.sessionId;
    send(0, browserFrame("AGENT_PROMPT", { agentId: "codex", sessionId, chatId: "shared-chat", userMessageId: randomUUID(), prompt: [{ type: "text", text: "keep running across app disconnect" }] }));
    await expect.poll(() => driver.prompts.length).toBe(1); await worker.flush();
    apps[0]!.close();
    await expect.poll(() => apps[0]!.readyState).toBe(WebSocket.CLOSED);
    expect(driver.disposed).toBe(false);
    historyGate = new Promise<void>(resolve => { release = resolve; });
    driver.emit({ sessionUpdate: "agent_message_chunk", messageId: "answer", content: { type: "text", text: "final shared turn" } });
    await expect.poll(() => frames[1]!.some(frame => frame.type === "AGENT_SESSION_UPDATE")).toBe(true);
    workspace.state = "stopping";
    let acknowledged = false;
    const stopping = relays[0]!.stopWorkspace(workspace, 5000).then(ok => { acknowledged = ok; return ok; });
    await expect.poll(() => blocked).toBe(true);
    expect(acknowledged).toBe(false);
    release(); expect(await stopping).toBe(true);
    expect(driver.disposed).toBe(true);
    expect([...rows.values()].some(row => row.payload.includes("final shared turn"))).toBe(true);
  } finally {
    release?.(); for (const app of apps) app.terminate(); for (const relay of relays) relay.close();
    await worker.dispose();
    for (const server of servers) await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => api.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
