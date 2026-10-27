import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { EventEmitter, once } from "node:events";
import { randomUUID, timingSafeEqual } from "node:crypto";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as workos from "../dev-environment/workos.mjs";
import {
  acquireWorkspaceLock, ensureWorkspace, privateDirectory, readPrivateJson,
  saveWorkspace, writePrivateFile,
} from "../dev-environment/state.mjs";
import { publicDevProfile } from "../dev-environment/profile.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dev-webhook-lifecycle-")); roots.push(root);
  const workspace = ensureWorkspace({ repositoryRoot: root, homeDir: root, env: {} });
  const profile = {
    version: 1,
    cloudflare: { accountId: "a".repeat(32), zoneId: "b".repeat(32), domain: "example.test", apiToken: "cloudflare-sentinel" },
    workos: { environment: "alpha", webClientId: "client_fixture", desktopClientId: "client_desktop", apiKey: "workos-credential-sentinel" },
  };
  const foreign = { id: "we_OTHER", endpoint_url: "https://api-alpha.example.test/auth/workos-webhook",
    secret: "foreign-webhook-sentinel", status: "enabled", events: ["user.deleted"] };
  const hooks: any[] = [structuredClone(foreign)];
  const steps: string[] = [];
  const faults = { lostCreate: false, lostPatch: false, refusePause: false, ignorePatch: false };
  const request = vi.fn(async (route: string, { method = "GET", body }: any = {}) => {
    if (method === "GET") return { data: structuredClone(hooks), list_metadata: {} };
    if (method === "POST") {
      const hook = { id: "we_DEV", ...body, secret: "dev-webhook-sentinel-secret", status: "enabled" };
      hooks.push(hook);
      if (faults.lostCreate) { faults.lostCreate = false; throw new Error("lost create response"); }
      return structuredClone(hook);
    }
    if (method === "PATCH") {
      const hook = hooks.find(value => route === `/webhook_endpoints/${value.id}`);
      if (!hook) throw new Error("unknown endpoint");
      if (faults.refusePause && body.status === "disabled") throw new Error("provider unavailable");
      if (!faults.ignorePatch) Object.assign(hook, body);
      steps.push(`webhook:${body.status}`);
      if (faults.lostPatch) { faults.lostPatch = false; throw new Error("lost patch response"); }
      return structuredClone(hook);
    }
    throw new Error("unexpected provider mutation");
  });
  return { root, workspace, profile, foreign, hooks, steps, faults, request };
}

describe("local Dev webhook lifecycle", () => {
  it("keeps one cancellation deadline across paginated provider cleanup", async () => {
    const f = fixture(), controller = new AbortController();
    let pages = 0;
    const fetch = vi.fn(async () => {
      pages += 1; controller.abort();
      return Response.json({ data: [], list_metadata: { after: `page-${pages}` } });
    });
    await expect(workos.endpoints(workos.workosClient(f.profile, fetch, { signal: controller.signal }))).rejects.toThrow(/unavailable/i);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("leaves a newly provisioned endpoint paused before public readiness", async () => {
    const f = fixture();
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    expect(f.hooks[1]).toMatchObject({ status: "disabled", events: workos.WORKOS_DEV_EVENTS });
    expect(readPrivateJson(f.workspace.file).workosWebhook).toMatchObject({ id: "we_DEV", status: "disabled", pausePending: false });
    expect(f.hooks[0]).toEqual(f.foreign);
  });

  it("resumes and pauses the same endpoint and signing key without replacing it", async () => {
    const f = fixture();
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    const original = structuredClone(f.workspace.state.workosWebhook);
    await workos.enableWorkosWebhook(f.workspace, f.profile, f.request);
    expect(f.hooks[1].status).toBe("enabled");
    await workos.pauseWorkosWebhook(f.workspace, f.profile, f.request);
    await workos.pauseWorkosWebhook(f.workspace, f.profile, f.request);
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    expect(f.workspace.state.workosWebhook).toMatchObject({ id: original.id, secret: original.secret, status: "disabled" });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
    expect(f.hooks[0]).toEqual(f.foreign);
  });

  it("pauses a created endpoint even when the create response was lost", async () => {
    const f = fixture(); f.faults.lostCreate = true;
    await expect(workos.ensureWorkosWebhook(f.workspace, f.profile, f.request)).rejects.toThrow("lost create response");
    await workos.pauseWorkosWebhook(f.workspace, f.profile, f.request);
    expect(f.hooks[1].status).toBe("disabled");
    expect(readPrivateJson(f.workspace.file).workosWebhook).toMatchObject({ id: "we_DEV", status: "disabled", pausePending: false });
    expect(f.hooks).toHaveLength(2);
  });

  it("retains pending cleanup after a lost pause response and confirms it on retry", async () => {
    const f = fixture();
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    await workos.enableWorkosWebhook(f.workspace, f.profile, f.request);
    f.faults.lostPatch = true;
    await expect(workos.pauseWorkosWebhook(f.workspace, f.profile, f.request)).rejects.toThrow("lost patch response");
    expect(readPrivateJson(f.workspace.file).workosWebhook.pausePending).toBe(true);
    await workos.pauseWorkosWebhook(f.workspace, f.profile, f.request);
    expect(readPrivateJson(f.workspace.file).workosWebhook).toMatchObject({ pausePending: false, status: "disabled" });
    expect(f.hooks[0]).toEqual(f.foreign);
  });

  it("does not report a pause when the provider leaves the endpoint enabled", async () => {
    const f = fixture();
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    await workos.enableWorkosWebhook(f.workspace, f.profile, f.request);
    f.faults.ignorePatch = true;
    await expect(workos.pauseWorkosWebhook(f.workspace, f.profile, f.request)).rejects.toThrow(/confirm|verification/i);
    expect(f.workspace.state.workosWebhook.pausePending).toBe(true);
  });

  it.each(["id", "url", "secret", "client", "instance"])("refuses to pause a replaced %s identity", async changed => {
    const f = fixture();
    await workos.ensureWorkosWebhook(f.workspace, f.profile, f.request);
    await workos.enableWorkosWebhook(f.workspace, f.profile, f.request);
    if (changed === "id") f.hooks[1].id = "we_REPLACED";
    if (changed === "url") f.hooks[1].endpoint_url = "https://foreign.example.test/auth/workos-webhook";
    if (changed === "secret") f.hooks[1].secret = "replaced-webhook-sentinel-secret";
    if (changed === "client") f.profile.workos.webClientId = "client_changed";
    if (changed === "instance") f.workspace.state.instanceId = randomUUID();
    f.request.mockClear();
    await expect(workos.pauseWorkosWebhook(f.workspace, f.profile, f.request)).rejects.toThrow();
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "PATCH")).toHaveLength(0);
    expect(f.hooks[0]).toEqual(f.foreign);
    expect(f.hooks[1].status).toBe("enabled");
  });
});

const source = fs.readFileSync(new URL("../dev-environment/launcher.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("launcher.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const callbacks = ast.statements.filter((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) &&
  ["start", "stop", "pauseStoppedWebhook"].includes(node.name?.text ?? "")).map(node => node.getText(ast));

function launcher({ startupFailure = false, cleanupFailure = false, cancelAtReadiness = false } = {}) {
  const f = fixture(), controller = new AbortController();
  for (const file of ["node_modules/.bin/tsup", "apps/control-plane/node_modules/pg", "apps/web/node_modules/wrangler", "apps/web/functions"]) {
    fs.mkdirSync(path.join(f.root, file), { recursive: true });
  }
  const emitter = new EventEmitter();
  Object.assign(emitter, { execPath: process.execPath, pid: process.pid });
  const server = Object.assign(new EventEmitter(), {
    listen: () => queueMicrotask(() => server.emit("listening")), address: () => ({ port: 4242 }),
    closeAllConnections: () => {}, close: (done: () => void) => done(),
  });
  const enable = vi.fn(() => workos.enableWorkosWebhook(f.workspace, f.profile, f.request));
  const pause = vi.fn((w = f.workspace) => workos.pauseWorkosWebhook(w, f.profile, f.request));
  const stopProcesses = vi.fn(async () => { f.steps.push("processes:stop"); });
  const seed = vi.fn(async () => {
    f.steps.push(`seed:${f.hooks[1].status}`);
    f.faults.refusePause = cleanupFailure;
    controller.abort(new Error("Development shutdown requested"));
  });
  const context = vm.createContext({
    fs, path, once, randomUUID, timingSafeEqual, privateDirectory, writePrivateFile,
    saveWorkspace, readPrivateJson, acquireWorkspaceLock,
    root: f.root, action: "backend", watch: false, process: emitter, globalThis: { AbortSignal },
    systemEnvironment: () => ({}), currentBoot: () => "fixture-boot", recoverLaunchAfterReboot: () => false,
    profileIssues: () => [], loadProfile: () => f.profile, verifyAlpha: async () => {},
    DevelopmentProcesses: class { controller = controller; start() {} stop = stopProcesses; },
    createServer: () => server, run: async () => {}, resolveLocalRuntime: async () => "a".repeat(64),
    pickServicePorts: async () => ({ api: 21001, database: 21002, web: 21003, tunnelMetrics: 21004 }),
    startPostgres: async () => ({ stop: async () => { f.steps.push("postgres:stop"); } }),
    migratePostgres: async () => {}, ensureTunnel: async () => ({ tokenFile: "/unused" }), configureTunnel: async () => {},
    ensureWorkosWebhook: () => workos.ensureWorkosWebhook(f.workspace, f.profile, f.request),
    enableWorkosWebhook: enable, pauseWorkosWebhook: pause,
    publicDevProfile, backendEnvironment: () => ({ CLOUD_V2_RUNTIME_SHA256: "a".repeat(64) }), webEnvironment: () => ({}),
    waitForHttp: async () => {}, waitForDevSignIn: async () => {
      if (startupFailure) throw new Error("public sign-in unavailable");
      if (cancelAtReadiness) controller.abort(new Error("Development shutdown requested"));
      f.steps.push("public:ready");
    },
    cloudSeedNeeded: () => true, seedCloud: seed, delay: async () => {},
    console: { log: vi.fn(), warn: vi.fn() },
  });
  vm.runInContext(callbacks.join("\n") + "\nglobalThis.callbacks = {start, stop};", context);
  return { ...f, enable, pause, stopProcesses, context,
    callbacks: context.globalThis.callbacks as { start: (w: typeof f.workspace, p: object) => Promise<void>; stop: (w: typeof f.workspace) => Promise<void> } };
}

describe("local Dev supervisor webhook ownership", () => {
  it("enables after readiness and pauses before stopping owned services", async () => {
    const h = launcher();
    await expect(h.callbacks.start(h.workspace, h.profile)).rejects.toThrow("Development shutdown requested");
    expect(h.steps).toEqual(["webhook:disabled", "public:ready", "webhook:enabled", "seed:enabled", "webhook:disabled", "processes:stop", "postgres:stop"]);
    expect(h.hooks[1].status).toBe("disabled");
    expect(readPrivateJson(h.workspace.file).launcher).toBeUndefined();
    expect(fs.existsSync(path.join(h.workspace.directory, "run.lock"))).toBe(false);
  });

  it("keeps the endpoint paused after failed public startup", async () => {
    const h = launcher({ startupFailure: true });
    await expect(h.callbacks.start(h.workspace, h.profile)).rejects.toThrow("public sign-in unavailable");
    expect(h.enable).not.toHaveBeenCalled();
    expect(h.hooks[1].status).toBe("disabled");
    expect(h.stopProcesses).toHaveBeenCalledOnce();
  });

  it("drains processes despite a provider outage and retries pause on a later stop", async () => {
    const h = launcher({ cleanupFailure: true });
    await expect(h.callbacks.start(h.workspace, h.profile)).rejects.toThrow(/webhook.*pause|pause.*webhook/i);
    expect(h.stopProcesses).toHaveBeenCalledOnce();
    expect(readPrivateJson(h.workspace.file).launcher).toBeUndefined();
    expect(readPrivateJson(h.workspace.file).workosWebhook.pausePending).toBe(true);
    expect(fs.existsSync(path.join(h.workspace.directory, "run.lock"))).toBe(false);
    h.faults.refusePause = false;
    await h.callbacks.stop(h.workspace);
    expect(h.hooks[1].status).toBe("disabled");
    expect(readPrivateJson(h.workspace.file).workosWebhook.pausePending).toBe(false);
    expect(h.stopProcesses).toHaveBeenCalledOnce();
  });

  it("pauses an old enabled webhook even when no launcher receipt remains", async () => {
    const h = launcher();
    await workos.ensureWorkosWebhook(h.workspace, h.profile, h.request);
    h.hooks[1].status = "enabled";
    await h.callbacks.stop(h.workspace);
    expect(h.hooks[1].status).toBe("disabled");
    expect(h.stopProcesses).not.toHaveBeenCalled();
    expect(h.hooks[0]).toEqual(h.foreign);
  });

  it("does not enable delivery after shutdown arrives at public readiness", async () => {
    const h = launcher({ cancelAtReadiness: true });
    await expect(h.callbacks.start(h.workspace, h.profile)).rejects.toThrow("Development shutdown requested");
    expect(h.enable).not.toHaveBeenCalled();
    expect(h.hooks[1].status).toBe("disabled");
  });

  it("does not let a stale idle stop pause a successor's live webhook", async () => {
    const h = launcher();
    await workos.ensureWorkosWebhook(h.workspace, h.profile, h.request);
    await workos.enableWorkosWebhook(h.workspace, h.profile, h.request);
    const stale = structuredClone(h.workspace);
    h.workspace.state.launcher = { pid: process.pid, port: 4242, token: "synthetic-token", runId: "new-run" };
    saveWorkspace(h.workspace);
    h.request.mockClear();
    await expect(h.callbacks.stop(stale)).rejects.toThrow(/confirmed shutdown/i);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.hooks[1].status).toBe("enabled");
    expect(readPrivateJson(h.workspace.file).launcher.runId).toBe("new-run");
  });
});
