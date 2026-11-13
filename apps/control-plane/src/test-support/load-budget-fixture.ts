import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { serve } from "@hono/node-server";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type pg from "pg";
import { vi } from "vitest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { workosTestAuth } from "../test-workos-env.js";
import { RailwayWorkOSProvider, type WorkOSExchange } from "../workos-provider.js";
import { PostgresWorkOSBrowserSessionRepository, WorkOSBrowserSessions, WORKOS_SESSION_COOKIE } from "../workos-browser-sessions.js";
import { executionFixture } from "../cloud/execution/test-fixture.js";
import { CloudV2BeginActiveReplySchema, type CloudV2MessageRow } from "../cloud/contract.js";
import { CloudV2PromptPullReplySchema } from "../cloud/prompt-contract.js";
import { deferred, holdLoadStream, IDLE_WINDOW_MS, type LoadBudgetProbe } from "./load-budget.js";

// Counts supplied from Alpha. Unspecified stream/discovery counts contribute
// one initial open/read each; these are a lower bound, not invented polling.
export const OBSERVED_IDLE_REPLAY = [
  { operation: "workspace-list", count: 10 }, { operation: "me", count: 8 }, { operation: "browser-session", count: 17 },
  { operation: "prompts", count: 48 }, { operation: "pull", count: 35 }, { operation: "history", count: 21 },
  { operation: "renew", count: 22 }, { operation: "workspace", count: 25 }, { operation: "heartbeat", count: 13 },
  { operation: "activity", count: 9 }, { operation: "connections", count: 1 },
] as const;
type Device = { deviceId: string; registrationId: string; instanceId: string };
type DeviceClient = { register(id: string, input: unknown): Promise<{ device: Device }>; connect(device: Device, workspace: string): Promise<unknown>;
  heartbeat(device: Device): Promise<unknown>; syncConnections(device: Device): Promise<unknown>;
  events(device: Device, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> };
type WorkerClient = { bootId: string; promptRequest(operation: string, body: unknown): Promise<unknown>;
  contextRequest(path: string, body: unknown): Promise<unknown>; dispose(): Promise<void> };
type PromptClient = { enqueue(body: unknown): Promise<unknown>; list(after: string, includePayload: boolean): Promise<unknown> };
type StreamStore = { upsert(chat: unknown): Promise<void>; enqueue(chatId: string, input: unknown): Promise<unknown>;
  claim(chatId: string): Promise<unknown>; importMessages(chatId: string, rows: CloudV2MessageRow[]): Promise<unknown>;
  fold(chatId: string, update: unknown): Promise<unknown>; finish(chatId: string, requestId: string, result: unknown): Promise<unknown>;
  history(chatId: string): readonly CloudV2MessageRow[]; flush(): Promise<void> };
type StreamMirror = { connect(): void; flush(): Promise<boolean>; dispose(): Promise<void> };
export const RUNNING_TURN = { milliseconds: 60_000, deltas: 300, deltaCharacters: 100 } as const;
const requireValue = (condition: unknown, reason: string): void => { if (!condition) throw new Error(`Load fixture: ${reason}`); };
const baseUrl = "https://api.example.test";
async function closeAll(cleanups: Array<() => Promise<void>>): Promise<void> {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw errors[0];
}

export async function loadBudgetFixture(pool: pg.Pool, probe: LoadBudgetProbe) {
  const nativeFetch = globalThis.fetch;
  const f = await executionFixture(pool, { teamOwnership: true });
  const cleanups: Array<() => Promise<void>> = [() => f.close(), () => f.cp.teamSharing.signals.close()];
  const close = () => closeAll(cleanups);
  try {
    await pool.query("DELETE FROM cloud_v2_workspaces WHERE id=$1", [f.own.id]);
    await f.login(); await f.activate();
    const pair = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: "load-budget", alg: "RS256", use: "sig" };
    const jwks = createServer((_request, response) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ keys: [jwk] })); });
    await new Promise<void>(resolve => jwks.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise<void>(resolve => jwks.close(() => resolve())));
    const address = jwks.address();
    if (!address || typeof address === "string") throw new Error("Load fixture: JWKS address unavailable");
    const auth = { ...workosTestAuth(), jwksUrl: `http://127.0.0.1:${address.port}/jwks` };
    const sign = (sessionId: string, clientId: string) => new SignJWT({ sid: sessionId, client_id: clientId,
      auth_time: Math.floor(Date.now() / 1000), "https://zeros.build/email": f.creator.email,
      "https://zeros.build/email_verified": true, "https://zeros.build/name": "Load fixture" })
      .setProtectedHeader({ alg: "RS256", kid: "load-budget" }).setIssuer(auth.issuer).setAudience(auth.audience)
      .setSubject(f.creator.identity.subject).setJti(randomUUID()).setIssuedAt().setExpirationTime("1h").sign(pair.privateKey);
    const desktopToken = await sign(f.creator.authentication.sessionId!, auth.desktopClientId);
    const browserSessionId = `session_${randomUUID()}`;
    const exchange: WorkOSExchange = { sealedSession: `synthetic-seal-${randomUUID()}`, sessionId: browserSessionId,
      accessToken: await sign(browserSessionId, auth.webClientId), accessTokenExpiresAt: Date.now() + 3_600_000,
      user: { id: f.creator.identity.subject, email: f.creator.email, emailVerified: true, name: "Load fixture" } };
    const signing = generateKeyPairSync("ed25519");
    const workos = { appOrigin: "https://app.example.test", opsOrigin: null, apiKey: "synthetic-load-key",
      cookiePassword: "synthetic-load-cookie-password", webhookSecret: "synthetic-load-webhook-secret" };
    const config: Config = { databaseUrl: process.env.TEST_DATABASE_URL!, auth, workos, port: 0, isProduction: false,
      deploymentChannel: "alpha", inviteLinkBase: "https://app.example.test/invite", feedback: null, github: null,
      slowRequestLogMs: Infinity, cloudAgentCredentials: { settingsSecretKeyV1: f.keys.keys[1],
        settingsSecretEncryptionKeys: f.keys.keys, currentSettingsSecretEncryptionKeyVersion: f.keys.currentKeyVersion },
      cloudV2: { teamOwnership: true, promptOutbox: true, boat: { apiKey: "synthetic-load-boat" }, apiUrl: baseUrl,
        realtimeUrl: "wss://rt.example.test", workerSigningKey: signing.privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
        runtime: { sha256: "b".repeat(64), store: { endpoint: "https://store.example.test", bucket: "fixture", accessKeyId: "fixture", secretAccessKey: "fixture" } } } };
    const provider = new RailwayWorkOSProvider(auth, workos);
    vi.spyOn(provider, "authorizationUrl").mockImplementation(({ state }) => `https://identity.example.test/authorize?state=${state}`);
    vi.spyOn(provider, "exchange").mockResolvedValue(exchange);
    vi.spyOn(provider, "restore").mockResolvedValue({ status: "active", ...exchange });
    vi.spyOn(provider, "refresh").mockResolvedValue({ status: "active", ...exchange });
    const browser = new WorkOSBrowserSessions(new PostgresWorkOSBrowserSessionRepository(pool), provider, workos.appOrigin);
    const started = await browser.start({ returnPath: "/" });
    const completed = await browser.complete({ credential: started.credential, code: "synthetic-code",
      state: new URL(started.authorizationUrl).searchParams.get("state")! });
    requireValue(completed.ok, "browser session setup failed");

    let pollWaits = 0;
    const app = createApp(config, pool, { from: null, apiKey: null } as never,
      { cloudV2: { ...f.cp, workers: { ...f.cp.workers, waitForPrompts: (id, _milliseconds, signal) => {
        pollWaits++;
        // Keep the real long-poll branch, including its second authority/read
        // pass. Only the signal's transport timer advances immediately.
        return f.cp.workers.waitForPrompts!(id, 0, signal);
      } } }, cloudApi: f.cp.api, workosProvider: provider, requestCostObserver: probe.observe });
    const listening = deferred<number>(), serving = new Set<Promise<Response>>();
    const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
      const reply = probe.request(request, () => app.fetch(request), false);
      serving.add(reply);
      try { return await reply; } finally { serving.delete(reply); }
    } }, info => listening.resolve(info.port));
    server.on("error", listening.reject);
    const port = await listening.promise;
    cleanups.push(async () => {
      await Promise.allSettled(serving);
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin === baseUrl) return nativeFetch(new Request(`http://127.0.0.1:${port}${url.pathname}${url.search}`, request));
      if (url.origin === new URL(auth.jwksUrl).origin) return nativeFetch(request);
      if (url.origin === "https://api.github.com") return f.fetcher(input, init);
      throw new Error("Load fixture: unexpected external transport");
    };
    vi.stubGlobal("fetch", fetcher);
    const desktop = (path: string, body?: unknown, extra: Record<string, string> = {}, signal?: AbortSignal) => fetcher(`${baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST", ...(signal ? { signal } : {}),
      headers: { authorization: `Bearer ${desktopToken}`, "x-zeros-team-sharing": "1", "x-zeros-team-ownership": "1", ...extra,
        ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = async (response: Response): Promise<Record<string, unknown>> => {
      requireValue(response.ok, `setup route status ${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const workspacePath = `/v1/cloud-v2/workspaces/${f.workspace.id}`;
    const root = new URL(process.env.CLOUD_API_TEST_CLIENT_ROOT ?? "../../../../", import.meta.url);
    const source = (path: string) => new URL(path, root).href;
    const renderer = "apps/desktop/src/renderer/";
    let deviceContext: { deviceId: string; headers: Record<string, string> } | null = null;
    vi.doMock(new URL(`${renderer}platform/runtime.ts`, root).pathname, () => ({ isElectron: () => true, isLocalDevelopment: () => false,
      nativeInvoke: async (command: string) => command === "local_commands_device" ? deviceContext : { version: "1.0.0", runtimeMode: "dev" },
      nativeListen: async () => () => {} }));
    vi.doMock(new URL(`${renderer}features/auth/auth-store.ts`, root).pathname, () => ({ getSession: async () => ({ access_token: desktopToken }) }));
    vi.doMock(new URL(`${renderer}features/team/team-store.ts`, root).pathname, () => ({ getOrganizationStoreGeneration: () => 0, getTeamStoreState: () => ({}) }));
    vi.doMock(new URL(`${renderer}features/team/control-plane.ts`, root).pathname, () => ({ CONTROL_PLANE_URL: baseUrl, ControlPlaneError: class extends Error {} }));
    vi.doMock(new URL(`${renderer}config/release-channel.ts`, root).pathname, () => ({ isFeatureEnabled: () => true, CHANNEL: "alpha" }));
    const deviceModule = await import(source("apps/desktop/electron/local-commands/control.ts")) as {
      DeviceControl: new (options: { fetch: typeof fetch; baseUrl(): string; token(): Promise<string> }) => DeviceClient };
    const workerModule = await import(source("apps/cloud-worker/src/hybrid-transport.ts")) as {
      HybridTransport: new (options: { apiUrl: string; workspaceId: string; runtimeSha256: string; tokenFile: string;
        publicKeys: string[]; port: number; fetch: typeof fetch }) => WorkerClient };
    const promptModule = await import(source(`${renderer}platform/cloud-prompt-api.ts`)) as {
      cloudPromptApi(target: { organizationId: string; workspaceId: string }, chatId: string): PromptClient };
    const { CLOUD_WORKER_FEATURES } = await import(source("apps/cloud-worker/src/worker-features.ts")) as { CLOUD_WORKER_FEATURES: string };
    const { CLOUD_V2_PROMPT_POLL_MS } = await import(source("packages/protocol/src/cloud-v2-prompts.ts")) as { CLOUD_V2_PROMPT_POLL_MS: number };
    const control = new deviceModule.DeviceControl({ fetch: fetcher, baseUrl: () => baseUrl, token: async () => desktopToken });
    const { device } = await control.register(randomUUID(), { requestId: randomUUID(), name: "Load fixture", capabilities: ["local-commands-v1", "local-commands-reason-v1"] });
    deviceContext = { deviceId: device.deviceId, headers: { "X-Zeros-Device-Id": device.deviceId,
      "X-Zeros-Device-Registration": device.registrationId, "X-Zeros-Device-Instance": device.instanceId } };
    const directory = await mkdtemp(join(tmpdir(), "load-budget-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const tokenFile = join(directory, "worker-token");
    await writeFile(tokenFile, f.token, { mode: 0o600 });
    const worker = new workerModule.HybridTransport({ apiUrl: baseUrl, workspaceId: f.workspace.id, runtimeSha256: "b".repeat(64),
      tokenFile, publicKeys: f.workerPublicKeys, port: 0, fetch: fetcher });
    cleanups.push(() => worker.dispose());
    const workerJson = (path: string, body: unknown) => fetcher(`${baseUrl}/v2/cloud/worker/${path}`, { method: "POST",
      headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-zeros-worker-boot": worker.bootId,
        "x-zeros-worker-features": CLOUD_WORKER_FEATURES }, body: JSON.stringify(body) }).then(json);
    const hello = await workerJson("hello", { protocol: 2, bootId: worker.bootId, runtimeSha256: "b".repeat(64) });
    requireValue((hello.config as { actingUser?: number })?.actingUser === 1, "workspace is not activated");
    await worker.contextRequest("execution-leases/boot-clean", { retirementId: randomUUID(), processes: 0, legacyMaterial: "none" });
    await control.connect(device, f.workspace.id);
    const connected = await desktop(`${workspacePath}/connect`, { wake: false }).then(json);
    const token = (connected.protocols as string[])[1]!.slice(7);
    const grant = await f.cp.store.consumeConnectTicket(token, f.workspace.id);
    if (!grant) throw new Error("Load fixture: client grant unavailable");
    const client = await f.cp.execution.clients.open(f.workspace.id, randomUUID(), grant);
    const prompts = promptModule.cloudPromptApi({ organizationId: f.organizationId, workspaceId: f.workspace.id }, "chat");
    const workspaceList = async () => {
      const reply = await desktop(`/v1/cloud-v2/workspaces?organizationId=${f.organizationId}`).then(json);
      const rows = reply.workspaces as Array<{ id: string }>;
      requireValue(rows.length === 1 && rows[0]!.id === f.workspace.id, "list must admit exactly one workspace");
      return reply;
    };
    const renew = async () => {
      const result = await worker.contextRequest("execution-leases/renew", { contextIds: [client.contextId] }) as { leases: Array<{ contextId: string; expiresAt?: number; refused?: unknown }> };
      requireValue(result.leases.length === 1 && result.leases[0]!.contextId === client.contextId &&
        !result.leases[0]!.refused && Number(result.leases[0]!.expiresAt) > Date.now(), "renewal must extend a live client context");
    };
    const turnStart = async () => {
      const input = f.prompt();
      await prompts.enqueue(input);
      const pulled = CloudV2PromptPullReplySchema.parse(await worker.promptRequest("pull", { waitMs: 0, held: [] }));
      const offered = pulled.prompts.find(value => value.payload.userMessageId === input.userMessageId);
      if (!offered) throw new Error("Load fixture: prompt not offered");
      await worker.promptRequest("ack", { userMessageId: input.userMessageId, deliveryId: offered.deliveryId });
      const begin = { userMessageId: input.userMessageId, deliveryId: offered.deliveryId, dispatchId: randomUUID() };
      const begun = CloudV2BeginActiveReplySchema.parse(await worker.promptRequest("begin", begin));
      const lease = await worker.contextRequest("turn-lease", { chatId: input.chatId, userMessageId: input.userMessageId,
        dispatchId: begin.dispatchId, generation: begun.actingUser.generation, contextId: begun.contextId }) as { contextId: string; expiresAt: number };
      requireValue(lease.contextId === begun.contextId && lease.expiresAt > Date.now(), "turn lease must be usable");
      return { begin, contextId: lease.contextId };
    };
    const finishTurn = async (turn: Awaited<ReturnType<typeof turnStart>>) => {
      await worker.promptRequest("outcome", { userMessageId: turn.begin.userMessageId, dispatchId: turn.begin.dispatchId, state: "completed" });
      await worker.contextRequest(`execution-leases/${turn.contextId}/retired`, { retirementId: randomUUID(), reason: "outcome", processes: 0 });
    };
    let sequence = 0;
    const runningTurn = async (turn: Awaited<ReturnType<typeof turnStart>>) => {
      const { SessionStore } = await import(source("apps/cloud-worker/src/sessions/session-store.ts")) as {
        SessionStore: { open(directory: string, workspaceKey: string): Promise<StreamStore> } };
      const { HistoryMirror } = await import(source("apps/cloud-worker/src/sessions/history-mirror.ts")) as {
        HistoryMirror: new (store: StreamStore, transport: { send(frame: unknown): Promise<boolean> }) => StreamMirror };
      const { CONTEXT_RENEW_MS } = await import(source("apps/cloud-worker/src/sharing/execution-contexts.ts")) as { CONTEXT_RENEW_MS: number };
      const workspaceKey = `cloud://${f.organizationId}/${f.workspace.id}`;
      const store = await SessionStore.open(join(directory, "running-turn"), workspaceKey);
      const chatId = "chat", answerId = "load-answer", messageId = "load-stream";
      await store.upsert({ id: chatId, folder: workspaceKey, title: "Load stream" });
      await store.enqueue(chatId, { requestId: turn.begin.dispatchId, userMessageId: turn.begin.userMessageId,
        prompt: [{ type: "text", text: "Load stream" }], startedAt: Date.now() });
      await store.claim(chatId);
      await store.importMessages(chatId, [{ msgId: answerId, kind: "text", createdAt: 1,
        payload: JSON.stringify({ id: answerId, kind: "text", role: "agent", messageId, createdAt: 1, text: "" }) }]);
      const flights = new Set<Promise<boolean>>(), release = deferred<void>();
      let hold = false, failed: unknown, frames = 0;
      const mirror = new HistoryMirror(store, { send: async frame => {
        if (hold) await release.promise;
        const operation = (async () => {
          try {
            requireValue(frame && typeof frame === "object" && "t" in frame && frame.t === "history", "unexpected stream carrier");
            await workerJson("history", { ...frame as object, bootId: worker.bootId, sequence: ++sequence });
            frames++; return true;
          } catch (error) { failed = error; return false; }
        })();
        flights.add(operation);
        try { return await operation; } finally { flights.delete(operation); }
      } });
      const settled = async () => {
        while (flights.size) await Promise.all([...flights]);
        if (failed !== undefined) throw failed;
      };
      const releaseEnd = () => { hold = false; release.resolve(); };
      cleanups.push(async () => { releaseEnd(); await mirror.dispose(); await store.flush(); });
      return {
        prepare: async () => {
          mirror.connect(); const connected = await mirror.flush();
          await settled(); requireValue(connected, "history mirror did not connect");
        },
        stream: async () => {
          const started = performance.now(); let nextRenewal = CONTEXT_RENEW_MS;
          const pace = async (at: number) => { const remaining = started + at - performance.now(); if (remaining > 0) await delay(remaining); };
          for (let index = 0; index < RUNNING_TURN.deltas; index++) {
            const at = index * RUNNING_TURN.milliseconds / RUNNING_TURN.deltas;
            await pace(at);
            await probe.at(at, async () => {
              if (at >= nextRenewal) {
                const reply = await worker.contextRequest("execution-leases/renew", { contextIds: [client.contextId, turn.contextId] }) as {
                  leases: Array<{ contextId: string; expiresAt?: number; refused?: unknown }> };
                requireValue(reply.leases.length === 2 && reply.leases.every(lease => !lease.refused && Number(lease.expiresAt) > Date.now()),
                  "running turn lost its live context");
                nextRenewal += CONTEXT_RENEW_MS;
              }
              await store.fold(chatId, { sessionId: "load-execution", update: { sessionUpdate: "agent_message_chunk", messageId,
                content: { type: "text", text: "x".repeat(RUNNING_TURN.deltaCharacters) } } });
            });
          }
          await pace(RUNNING_TURN.milliseconds);
          // Finish any request already sent. A due tail frame waits for the
          // separately measured turn-end phase rather than leaking between them.
          hold = true; await settled();
        },
        finish: async () => {
          releaseEnd();
          await store.finish(chatId, turn.begin.dispatchId, { stopReason: "end_turn" });
          requireValue(await mirror.flush(), "history mirror did not finish");
          await settled(); await store.flush(); await finishTurn(turn);
        },
        verify: async () => {
          const expected = [...store.history(chatId)].sort((a, b) => a.msgId.localeCompare(b.msgId));
          const actual = (await f.cp.store.windowMessages(f.workspace.id, chatId, 1000)).sort((a, b) => a.msgId.localeCompare(b.msgId));
          requireValue(JSON.stringify(actual) === JSON.stringify(expected), "running-turn durable history differs from the VM store");
          const answer = expected.find(row => row.msgId === answerId);
          requireValue(answer && JSON.parse(answer.payload).text === "x".repeat(RUNNING_TURN.deltas * RUNNING_TURN.deltaCharacters),
            "running turn did not fold every delta");
          return { ...RUNNING_TURN, frames, rows: actual.length };
        },
      };
    };
    const idleReplay = async (wallClock = false) => {
      const streams: Array<() => Promise<void>> = [];
      const startedAt = performance.now();
      const pace = async (at: number) => {
        const wait = at - (performance.now() - startedAt);
        if (wallClock && wait > 0) await delay(wait);
      };
      try {
        const deviceAbort = new AbortController();
        streams.push((await holdLoadStream(await control.events(device, deviceAbort.signal), deviceAbort)).stop);
        const workspaceAbort = new AbortController();
        const response = await desktop(`${workspacePath}/events`, undefined, { accept: "text/event-stream" }, workspaceAbort.signal);
        requireValue(response.body, "workspace stream missing");
        streams.push((await holdLoadStream(response.body!, workspaceAbort)).stop);
        const schedule = OBSERVED_IDLE_REPLAY.flatMap(({ operation, count }) => Array.from({ length: count }, (_, i) =>
          ({ operation, at: Math.floor(i * IDLE_WINDOW_MS / count) }))).sort((left, right) => left.at - right.at);
        for (const { operation, at } of schedule) {
          await pace(at);
          await probe.at(at, async () => {
            switch (operation) {
              case "workspace-list": await workspaceList(); break;
              case "me": await desktop("/v1/me").then(json); break;
              case "browser-session": {
                const reply = await fetcher(`${baseUrl}/auth/browser/session`, { headers: { cookie: `${WORKOS_SESSION_COOKIE}=${started.credential}` } }).then(json);
                requireValue(reply.status === "active", "browser session is not active"); break;
              }
              case "prompts": await prompts.list("0", false); break;
              case "pull": {
                const reply = CloudV2PromptPullReplySchema.parse(await worker.promptRequest("pull", { waitMs: CLOUD_V2_PROMPT_POLL_MS, held: [] }));
                requireValue(reply.prompts.length === 0, "idle worker received work"); break;
              }
              case "history": await workerJson("history", { t: "history", bootId: worker.bootId, sequence: ++sequence, chats: [] }); break;
              case "renew": await renew(); break;
              case "workspace": {
                const reply = await desktop(workspacePath).then(json);
                requireValue((reply.workspace as { id: string }).id === f.workspace.id, "workspace identity changed"); break;
              }
              case "heartbeat": await control.heartbeat(device); break;
              case "activity": await workerJson("activity", { idle: true }); break;
              case "connections": await control.syncConnections(device); break;
            }
          });
        }
        await pace(IDLE_WINDOW_MS);
      } finally { await closeAll(streams); }
    };
    const assertTransportCancellation = async () => {
      let cancelled = false;
      try { const response = await desktop("/v1/me", undefined, {}, AbortSignal.abort()); await response.body?.cancel(); }
      catch (error) { cancelled = error instanceof Error && error.name === "AbortError"; }
      requireValue(cancelled, "HTTP transport ignored cancellation");
    };
    return { close, workspaceList, turnStart, finishTurn, runningTurn, renew, idleReplay, assertTransportCancellation, pollWaits: () => pollWaits,
      observerStatus: () => app.requestCostObserverStatus!() };
  } catch (error) { await close(); throw error; }
}
