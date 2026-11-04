import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import { HybridTransport } from "../hybrid-transport";
import { InboundBridge } from "../inbound-bridge";
import { CloudWorker } from "../worker";
import { McpGateway } from "../mcp/gateway";
import { CLIENT_A, browserFrame, config } from "./worker-fixtures";
import { repositoryFixture } from "../workspace/__tests__/repository-fixture";

it("admits the first real dial while checkout reporting is held and applies HTTP then relay config in order", async () => {
  const fixture = await repositoryFixture(), tokenFile = join(fixture.state, "worker-token");
  await writeFile(tokenFile, "fixture-worker-token", { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519");
  let port = 0, release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const reporting = new Promise<void>(resolve => { entered = resolve; });
  const originalStart = InboundBridge.prototype.start;
  const listen = vi.spyOn(InboundBridge.prototype, "start").mockImplementation(async function (this: InboundBridge, receive) {
    const address = await originalStart.call(this, receive); port = address.port; return address;
  });
  const configuring = vi.spyOn(McpGateway.prototype, "configure");
  const snapshot = { ...config, workspace: fixture.scope.workspace, agents: {}, githubPullRequests: 1 as const };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: snapshot.workspace.id,
    runtimeSha256: "a".repeat(64), tokenFile, port: 0, publicKeys: [keys.publicKey.export({ type: "spki", format: "pem" }).toString()],
    retryBaseMs: 10, retryMaxMs: 20, fetch: async (url, init) => {
      const operation = new URL(String(url)).pathname.split("/").at(-1);
      if (operation === "hello" || operation === "config") return Response.json({ config: snapshot });
      if (operation === "activity") return Response.json({ state: "running", loginRevision: "0" });
      if (operation === "github-checkout") {
        const body = JSON.parse(String(init?.body)); entered(); await held;
        return Response.json({ sequence: body.sequence });
      }
      return new Response(null, { status: 404 });
    } });
  const worker = new CloudWorker({ transport, directory: fixture.state, homeDirectory: fixture.directory,
    workspaceServices: { watch: false }, prepareCheckout: async () => {}, drivers: {} });
  let socket: WebSocket | undefined;
  worker.start();
  try {
    await reporting;
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: snapshot.workspace.id, boot: transport.bootId,
      iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url");
    const payload = `v1.${claims}`, grant = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`;
    socket = new WebSocket(`ws://127.0.0.1:${port}/v2/worker/bridge`, "zeros.cloud.v2.worker", { headers: { "X-Zeros-Worker-Auth": grant } });
    const frames: Array<{ t: string; frame?: { type: string; requestId?: string } }> = [];
    socket.on("message", data => frames.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    socket.send(JSON.stringify({ ...snapshot, loginRevision: "1" }));
    socket.send(JSON.stringify({ t: "open", clientId: CLIENT_A }));
    const request = browserFrame("WORKSPACE_REQUEST", { op: "workspace.list", params: {} });
    socket.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame: request }));
    await expect.poll(() => frames.find(frame => frame.frame?.requestId === request.id)?.frame?.type, { timeout: 1500 }).toBe("WORKSPACE_RESPONSE");
    expect(frames.some(frame => frame.frame?.type === "ENGINE_READY")).toBe(true);
    expect(configuring.mock.calls.map(([, revision]) => revision)).toEqual(["0", "1"]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  } finally {
    release(); socket?.terminate(); await worker.dispose(); listen.mockRestore(); configuring.mockRestore();
  }
});
