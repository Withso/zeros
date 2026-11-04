import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { BridgeMessage } from "@zeros/protocol/messages";
import { CloudWorker } from "../worker";
import { HybridTransport } from "../hybrid-transport";
import { InboundBridge } from "../inbound-bridge";
import { askpass, brokerRequest, runGh } from "../credentials/client";
import { CLIENT_A, FakeDriver, browserFrame, config } from "./worker-fixtures";

it("finishes a broker request held across failed activity and same-revision HTTPS recovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "github-heartbeat-recovery-")), tokenFile = join(directory, "worker-token");
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const { publicKey } = generateKeyPairSync("ed25519");
  let release!: () => void, tokenRequests = 0, configReads = 0, failActivity = false, activityCalls = 0;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fetcher: typeof fetch = async url => {
    const path = new URL(String(url)).pathname.split("/").at(-1);
    if (path === "hello" || path === "config") { configReads++; return Response.json({ config }); }
    if (path === "github-token") { tokenRequests++; await hold; return Response.json({ token: "fixture-recovered-token", expiresAt: Date.now() + 120_000 }); }
    if (path === "activity") {
      activityCalls++;
      if (failActivity) { failActivity = false; return new Response(null, { status: 503 }); }
      return Response.json({ state: "running", loginRevision: config.loginRevision });
    }
    return Response.json({ sequence: 1 });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, publicKeys: [publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher, retryBaseMs: 1 });
  let socketPath = "";
  const worker = new CloudWorker({ githubFetch: async () => new Response(null, { status: 200 }), directory: join(directory, "state"), transport,
    prepareCheckout: async (_workspace, environment) => { socketPath = environment.GH_ZEROS_BROKER_SOCKET!; }, drivers: {} });
  try {
    worker.start();
    await expect.poll(() => activityCalls).toBeGreaterThan(0);
    const pending = brokerRequest(socketPath, "token").then(value => ({ value }), error => ({ error }));
    await expect.poll(() => tokenRequests).toBe(1);
    failActivity = true;
    await transport.send({ t: "idle", idle: false });
    await expect.poll(() => configReads).toBe(2);
    await worker.flush();
    release();
    expect(await pending).toMatchObject({ value: { token: "fixture-recovered-token" } });
    expect(await brokerRequest(socketPath, "token")).toMatchObject({ token: "fixture-recovered-token" });
    expect(tokenRequests).toBe(1);
  } finally { release(); await worker.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it.each(["claude", "codex"] as const)("serves new Git and gh broker clients after a %s turn and cache expiry", async agentId => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const directory = await mkdtemp(join(tmpdir(), "github-turn-complete-")), tokenFile = join(directory, "worker-token");
  const checkoutPath = join(directory, "checkout"), state = join(directory, "state");
  let socketPath = "";
  await mkdir(checkoutPath);
  await writeFile(tokenFile, "synthetic-worker-token", { mode: 0o600 });
  const keys = generateKeyPairSync("ed25519"), driver = new FakeDriver();
  const configuration = { ...config, githubPullRequests: 1 as const, githubUserTokens: 1 as const, workspace: { ...config.workspace, checkoutPath },
    agents: { ...config.agents, claude: { oauthToken: "fixture-claude-token" } } };
  const tokenRequests: string[] = [], replies: BridgeMessage[] = [];
  let port = 0, connected = false;
  const start = InboundBridge.prototype.start;
  const listener = vi.spyOn(InboundBridge.prototype, "start").mockImplementationOnce(async function (this: InboundBridge, receive) {
    const address = await start.call(this, receive); port = address.port; return address;
  });
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname.split("/").at(-1);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "hello" || path === "config") return Response.json({ config: configuration });
    if (path === "activity") return Response.json({ state: "running", loginRevision: configuration.loginRevision });
    if (path === "github-token") {
      const purpose = body.purpose ?? "git";
      tokenRequests.push(purpose);
      return Response.json({ token: "fixture-human", expiresAt: Date.now() + 120_000 });
    }
    return Response.json({ sequence: body.sequence });
  };
  const transport = new HybridTransport({ apiUrl: "https://api.example.test", workspaceId: config.workspace.id, runtimeSha256: "a".repeat(64),
    tokenFile, publicKeys: [keys.publicKey.export({ type: "spki", format: "pem" }).toString()], port: 0, fetch: fetcher,
    onStatus: status => { connected = status === "connected"; } });
  const worker = new CloudWorker({ githubFetch: async () => new Response(null, { status: 200 }), directory: state, transport,
    prepareCheckout: async (_workspace, environment) => { socketPath = environment.GH_ZEROS_BROKER_SOCKET!; }, drivers: { [agentId]: () => driver } });
  let socket: WebSocket | undefined;
  try {
    worker.start();
    await expect.poll(() => connected).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    const claims = Buffer.from(JSON.stringify({ iss: "zeros-cp", aud: config.workspace.id, boot: transport.bootId, iat: now, exp: now + 60, jti: randomUUID() })).toString("base64url");
    const payload = `v1.${claims}`, grant = `${payload}.${sign(null, Buffer.from(payload), keys.privateKey).toString("base64url")}`;
    socket = new WebSocket(`ws://127.0.0.1:${port}/v2/worker/bridge`, "zeros.cloud.v2.worker", { headers: { "X-Zeros-Worker-Auth": grant } });
    socket.on("message", raw => { const frame = JSON.parse(raw.toString()); if (frame.t === "frame") replies.push(frame.frame); });
    await new Promise<void>((resolve, reject) => { socket!.once("open", resolve); socket!.once("error", reject); });
    socket.send(JSON.stringify({ t: "open", clientId: CLIENT_A }));
    await expect.poll(() => replies.some(frame => frame.type === "ENGINE_READY")).toBe(true);
    const send = (frame: Record<string, unknown>) => socket!.send(JSON.stringify({ t: "frame", clientId: CLIENT_A, frame }));
    const response = (id: string) => replies.find(frame => "requestId" in frame && frame.requestId === id);
    const create = browserFrame("AGENT_NEW_SESSION", { agentId, chatId: "credential-chat", cwd: checkoutPath, workspaceId: config.workspace.id });
    send(create);
    await expect.poll(() => response(create.id)?.type).toBe("AGENT_SESSION_CREATED");
    const sessionId = (response(create.id) as Extract<BridgeMessage, { type: "AGENT_SESSION_CREATED" }>).session.sessionId;
    const prompt = browserFrame("AGENT_PROMPT", { agentId, sessionId, userMessageId: randomUUID(), prompt: [{ type: "text", text: "Fixture turn" }] });
    send(prompt);
    await expect.poll(() => driver.prompts.length).toBe(1);
    expect(await askpass("Password for 'https://x-access-token@github.com': ", socketPath)).toBe("fixture-human");
    expect(tokenRequests).toEqual(["git"]);
    driver.complete();
    await expect.poll(() => response(prompt.id)?.type).toBe("AGENT_PROMPT_COMPLETE");
    await worker.flush();
    socket.send(JSON.stringify(configuration));
    const pong = new Promise(resolve => socket!.once("pong", resolve)); socket.ping(); await pong;
    await worker.flush();
    expect(await askpass("Password for 'https://x-access-token@github.com': ", socketPath)).toBe("fixture-human");
    expect(tokenRequests).toEqual(["git"]);
    vi.setSystemTime(Date.now() + 121_000);
    expect(await askpass("Password for 'https://x-access-token@github.com': ", socketPath)).toBe("fixture-human");
    expect(await runGh(["pr", "list"], { GH_ZEROS_BROKER_SOCKET: socketPath }, async (_args, env) => {
      expect(env.GH_TOKEN).toBe("fixture-human"); return 0;
    })).toBe(0);
    expect(tokenRequests).toEqual(["git", "git"]);
  } finally {
    socket?.terminate(); await worker.dispose(); listener.mockRestore(); vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});
