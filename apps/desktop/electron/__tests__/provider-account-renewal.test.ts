import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("../secret-store", () => ({
  readSecretValues: (keys: string[]) => Object.fromEntries(keys.map(key => [key, secrets.get(key) ?? null])),
  updateSecretValues: (keys: string[], update: (values: Record<string, string | null>) => Record<string, string | null>) => {
    const next = update(Object.fromEntries(keys.map(key => [key, secrets.get(key) ?? null])));
    for (const key of keys) {
      if (next[key] === null) secrets.delete(key);
      else secrets.set(key, next[key]);
    }
  },
}));

import { ProviderAccountManager } from "../provider-account-manager";
import { readProviderAccounts, updateProviderAccounts } from "../provider-account-store";
import { ProviderSubscriptionController } from "../provider-subscription-controller";
import { createSubscriptionDriver } from "../provider-subscription-drivers";
import { AgentGateway } from "../../src/engine/agents/gateway";
import { testExecutionBoundary } from "../../src/engine/agents/__tests__/helpers/test-execution-boundary";
import type { StdioAgentProcess } from "../../src/engine/agents/adapters/shared/stdio-process";
import * as probes from "../../src/engine/agents/probes";
import * as providerEnv from "../../src/engine/settings/provider-env";
import * as credentials from "../../src/engine/agents/provider-credentials";

function deferred() {
  let resolve!: () => void;
  return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() };
}

function nativeLogin(provider: "claude" | "codex", barrier: "status" | "cleanup") {
  const opened = deferred(), status = deferred(), cleanup = deferred(), drain = deferred();
  let complete!: (success?: boolean) => void;
  let failStatus!: () => void;
  const driver = createSubscriptionDriver(provider, {
    resolveRuntime: async () => ({
      command: `/fixture/${provider}`, cwd: "/fixture/auth", env: {},
      cleanup: async () => {
        cleanup.resolve();
        if (barrier === "cleanup") await drain.promise;
      },
    }),
    openBrowser: async () => { opened.resolve(); },
    spawn: ({ args }) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      });
      let exit!: (value: { code: number | null; signal: null }) => void;
      const proc: StdioAgentProcess = {
        child: child as unknown as ChildProcess, processGroupId: null,
        exited: new Promise(resolve => { exit = resolve; }),
        stop: async () => { exit({ code: null, signal: null }); child.emit("close"); },
      };
      if (provider === "claude") {
        if (args[1] === "login") {
          complete = (success = true) => exit({ code: success ? 0 : 1, signal: null });
          queueMicrotask(() => child.stdout.write("https://claude.com/cai/oauth/authorize?state=fixture\n"));
        } else {
          failStatus = () => { child.stdout.write("invalid status"); exit({ code: 1, signal: null }); };
          status.resolve();
          if (barrier === "cleanup") queueMicrotask(() => {
            child.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "account@example.test" }));
            exit({ code: 0, signal: null });
          });
        }
      } else {
        complete = (success = true) => child.stdout.write(JSON.stringify({
          method: "account/login/completed", params: { loginId: "fixture-login", success },
        }) + "\n");
        child.stdin.on("data", chunk => {
          const request = JSON.parse(chunk.toString());
          if (!request.id) return;
          if (request.method === "account/read") {
            failStatus = () => child.stdout.write(JSON.stringify({ id: request.id,
              error: { code: -32603, message: "Synthetic status read failure" } }) + "\n");
            status.resolve();
            if (barrier === "status") return;
          }
          const result = request.method === "account/login/start"
            ? { type: "chatgpt", loginId: "fixture-login", authUrl: "https://auth.openai.com/oauth/authorize?state=fixture" }
            : request.method === "account/read"
              ? { account: { type: "chatgpt", email: "account@example.test", planType: "pro" } } : {};
          queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
        });
      }
      return proc;
    },
  });
  return { driver, opened, status, cleanup, drain, complete: (success = true) => complete(success), failStatus: () => failStatus() };
}

const accountId = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
function fixture(provider: "claude" | "codex", barrier: "status" | "cleanup") {
  updateProviderAccounts(provider, () => ({
    version: 1, method: "account", initialized: true, methodSelected: true,
    activeId: accountId, selectionRevision: 1,
    accounts: [accountId, otherId].map(id => ({
      id, state: "connected", revision: 1, configDir: `/fixture/${provider}/${id}`, email: "account@example.test",
    })),
  }));
  const native = nativeLogin(provider, barrier);
  const discard = vi.fn(async () => {}), changed = vi.fn(async () => {});
  const manager = new ProviderAccountManager({
    readStore: () => readProviderAccounts(provider),
    updateStore: update => updateProviderAccounts(provider, update),
    createProfile: async () => { throw new Error("Renewal must retain its profile"); },
    read: async () => ({ state: "connected", email: "account@example.test" }),
    login: async (_account, options) => ({ account: await native.driver.login(options) }),
    discard, changed,
  });
  const controller = new ProviderSubscriptionController(provider, manager, () => {});
  return { manager, controller, native, discard, changed, store: () => readProviderAccounts(provider) };
}

beforeEach(() => {
  secrets.clear();
  vi.spyOn(probes, "probeCliInstalled").mockResolvedValue(new Set(["claude", "codex"]));
  vi.spyOn(probes, "probeCliVersion").mockResolvedValue(null);
  vi.spyOn(probes, "evaluateAuthProbe").mockResolvedValue(true);
  vi.spyOn(providerEnv, "usesProviderApiKey").mockReturnValue(false);
  vi.spyOn(providerEnv, "applyUserProviderConfig").mockReturnValue({ env: {} });
  vi.spyOn(credentials, "providerAccountProfile").mockImplementation(provider => {
    if (provider !== "claude" && provider !== "codex") return null;
    const store = readProviderAccounts(provider);
    const account = store.accounts.find(a => a.id === store.activeId);
    return account ? { id: account.id, revision: account.revision, configDir: account.configDir, state: account.state } : null;
  });
});
afterEach(() => vi.restoreAllMocks());

describe.each(["claude", "codex"] as const)("%s saved account renewal", provider => {
  it.each(["before-write", "status", "cleanup"] as const)(
    "invalidates a rejected credential only after native completion (cancel at %s)",
    async phase => {
      const f = fixture(provider, phase === "cleanup" ? "cleanup" : "status");
      const gateway = new AgentGateway({
        projectRoot: "/tmp/zeros-renewal-fixture", executionBoundary: testExecutionBoundary(),
        events: { onSessionUpdate() {}, onPermissionRequest() {}, onQuestionRequest() {}, onAgentStderr() {}, onAgentExit() {} },
      });
      const authenticated = async () => (await gateway.refreshRegistry()).find(agent => agent.id === provider)?.authenticated;
      try {
        gateway.markAuthFailed(provider);
        expect(await authenticated()).toBe(false);
        const attempt = f.controller.connect(accountId);
        await f.native.opened.promise;
        if (phase !== "before-write") {
          f.native.complete();
          await (phase === "cleanup" ? f.native.cleanup : f.native.status).promise;
        }
        const canceling = f.controller.cancel(attempt.attemptId!);
        f.native.drain.resolve();
        const recovered = await canceling;
        expect(recovered).toMatchObject({ state: "connected", error: "Sign-in canceled.", activeAccountId: accountId });
        expect(f.store().accounts[0].revision).toBe(phase === "before-write" ? 1 : 2);
        expect(f.store().selectionRevision).toBe(1);
        expect(await authenticated()).toBe(phase !== "before-write");
        expect(f.changed).toHaveBeenCalledTimes(phase === "before-write" ? 0 : 1);
        expect(f.discard).not.toHaveBeenCalled();
      } finally {
        f.native.drain.resolve();
        await f.controller.dispose();
        await gateway.dispose();
      }
    },
  );

  it("publishes native completion even when the following status read fails", async () => {
    const f = fixture(provider, "status");
    const renewing = f.manager.login({ signal: new AbortController().signal, onCodeRequired() {}, accountId });
    const rejected = expect(renewing).rejects.toThrow();
    await f.native.opened.promise;
    f.native.complete();
    await f.native.status.promise;
    f.native.failStatus();
    await rejected;
    expect(f.store().accounts[0].revision).toBe(2);
    expect(f.changed).toHaveBeenCalledOnce();
    expect(f.discard).not.toHaveBeenCalled();
  });

  it("does not advance credentials when native login itself fails", async () => {
    const f = fixture(provider, "status");
    const renewing = f.manager.login({ signal: new AbortController().signal, onCodeRequired() {}, accountId });
    const rejected = expect(renewing).rejects.toThrow();
    await f.native.opened.promise;
    f.native.complete(false);
    await rejected;
    expect(f.store().accounts[0].revision).toBe(1);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  });

  it.each(["other-account", "A-B-A", "cli"])("keeps a later %s selection while publishing a completed native renewal", async selection => {
    const f = fixture(provider, "cleanup");
    const renewing = f.manager.login({ signal: new AbortController().signal, onCodeRequired() {}, accountId });
    const rejected = expect(renewing).rejects.toThrow("selected account changed");
    await f.native.opened.promise;
    f.native.complete();
    await f.native.cleanup.promise;
    await f.manager.select(otherId, new AbortController().signal);
    if (selection === "A-B-A") await f.manager.select(accountId, new AbortController().signal);
    if (selection === "cli") await f.manager.setMethod("cli");
    const selectionRevision = f.store().selectionRevision;
    f.native.drain.resolve();
    await rejected;
    expect(f.store()).toMatchObject({ activeId: selection === "A-B-A" ? accountId : otherId,
      method: selection === "cli" ? "cli" : "account", selectionRevision });
    expect(f.store().accounts[0].revision).toBe(2);
    expect(f.store().accounts[1].revision).toBe(1);
    expect(f.discard).not.toHaveBeenCalled();
  });

  it("advances from the current generation after another renewal finishes", async () => {
    const f = fixture(provider, "cleanup");
    const renewing = f.manager.login({ signal: new AbortController().signal, onCodeRequired() {}, accountId });
    await f.native.opened.promise;
    updateProviderAccounts(provider, store => ({ ...store,
      accounts: store.accounts.map(account => account.id === accountId ? { ...account, revision: 7 } : account),
    }));
    f.native.complete();
    await f.native.cleanup.promise;
    f.native.drain.resolve();
    await renewing;
    expect(f.store().accounts[0].revision).toBe(8);
    expect(f.changed).toHaveBeenCalledOnce();
  });

  it("does not resurrect a removed account after native completion", async () => {
    const f = fixture(provider, "cleanup");
    const renewing = f.manager.login({ signal: new AbortController().signal, onCodeRequired() {}, accountId });
    const rejected = expect(renewing).rejects.toThrow("no longer available");
    await f.native.opened.promise;
    await f.manager.remove(accountId);
    f.native.complete();
    await f.native.cleanup.promise;
    f.native.drain.resolve();
    await rejected;
    expect(f.store().accounts.map(account => account.id)).toEqual([otherId]);
    expect(f.store().activeId).toBeUndefined();
    expect(f.discard).toHaveBeenCalledTimes(2);
  });
});
