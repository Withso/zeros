// Regression for "Cursor still dies when the engine runs directly under Node".
//
// The node:sqlite store fix originally landed ONLY in host/cursor-host.cjs, which
// the engine reaches when it runs under bun (or packaged). shouldUseCursorHost()
// returns false for every other engine — `pnpm serve:engine` is
// `node dist-engine/cli.js`, and ZEROS_CURSOR_IN_PROCESS=1 forces it — and on
// that path the adapter imports @cursor/sdk directly. With no store passed, the
// SDK resolves its 1.0.26 default (node:sqlite, Node >= 22.5) and throws on the
// Node 20 that package.json's `engines` still allows, with the same causeless
// `Cannot access 'n' before initialization` TDZ on every attempt after the first.
//
// Neither cursor:smoke variant covers this — both drive cursor-host.cjs — so this
// pins for the IN-PROCESS path what host/__tests__/store-injection.test.ts pins
// for the host. The first block goes through the real CursorSdkAdapter, so it
// fails if loadSdk() ever stops wrapping the raw namespace; the second drives
// wrapSdkWithLocalStore directly for the shapes the adapter cannot reach.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CursorSdkAdapter } from "../adapter";
import { wrapSdkWithLocalStore, type RawCursorSdk } from "../local-store";
import type { AgentAdapterContext } from "../../../types";

const { createSpy, resumeSpy, listSpy, sendSpy, modelsListSpy, runGetSpy } =
  vi.hoisted(() => ({
    createSpy: vi.fn(),
    resumeSpy: vi.fn(),
    listSpy: vi.fn(),
    sendSpy: vi.fn(),
    modelsListSpy: vi.fn(),
    runGetSpy: vi.fn(),
  }));

/** Stub @cursor/sdk exporting what the package really exports: a
 *  JsonlLocalAgentStore CONSTRUCTOR plus getDefaultSdkStateRoot. There is no
 *  `LocalAgentStore` value on the real namespace — probing for one is exactly
 *  how the in-process error-recovery path went dead. */
vi.mock("@cursor/sdk", () => {
  let seq = 0;
  return {
    Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
    Cursor: { models: { list: modelsListSpy } },
    JsonlLocalAgentStore: class {
      readonly instanceId = `store${++seq}`;
      readonly runs = { get: runGetSpy };
      constructor(readonly rootDir: string) {}
    },
    // Deterministic and obviously synthetic, so an assertion cannot pass because
    // a real ~/.cursor path leaked in.
    getDefaultSdkStateRoot: (workspaceRef: string) =>
      `/state-root${workspaceRef}`,
  };
});

type Attached = { instanceId?: string; rootDir?: string } | undefined;

const nestedStore = (opts: unknown): Attached =>
  (opts as { local?: { store?: Attached } } | undefined)?.local?.store;
const topStore = (opts: unknown): Attached =>
  (opts as { store?: Attached } | undefined)?.store;

const fakeAgent = { agentId: "agent-xyz", send: sendSpy, close: () => {} };

function makeCtx(): AgentAdapterContext {
  return {
    projectRoot: "/tmp/proj",
    mcpServers: [],
    sessionDirRoot: "/tmp/proj/.sessions",
    emit: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  };
}

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; // short-circuit ensureRipgrep
});

beforeEach(() => {
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  runGetSpy.mockReset().mockResolvedValue(null);
});

const ENV = { CURSOR_API_KEY: "k" };

describe("CursorSdkAdapter in-process — the SDK is never left to pick a store", () => {
  it("newSession attaches a store at local.store, rooted at the SDK's own per-workspace state root", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({ cwd: "/w/alpha", env: ENV });

    // Not undefined: leaving this off is what made every Agent.create throw on a
    // runtime without node:sqlite.
    expect(nestedStore(createSpy.mock.calls[0][0])?.rootDir).toBe(
      "/state-root/w/alpha",
    );
  });

  it("loadSession (resume) attaches one too — resume hits the same default-store path", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.loadSession({
      sessionId: "prior-agent-id",
      cwd: "/w/beta",
      env: ENV,
    });

    expect(nestedStore(resumeSpy.mock.calls[0][1])?.rootDir).toBe(
      "/state-root/w/beta",
    );
  });

  it("listSessions puts the store at the TOP level, where ListAgentsOptions takes it", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.listSessions({ cwd: "/w/gamma" });

    const opts = listSpy.mock.calls[0][0];
    expect(topStore(opts)?.rootDir).toBe("/state-root/w/gamma");
    expect(nestedStore(opts)).toBeUndefined();
  });

  it("listSessions with NO cwd still gets a store — the chat-history path that silently returned empty", async () => {
    // engine/zeros-engine.ts passes cwd: undefined when a relay client's cwd falls
    // outside the workspace allowlist. getDefaultSdkStateRoot(undefined) throws,
    // so the old guard bailed out and left Agent.list on the node:sqlite default;
    // listSessions' catch then turned the throw into `{ sessions: [] }` with no
    // error surfaced to the user.
    const adapter = new CursorSdkAdapter(makeCtx());
    const res = await adapter.listSessions({});

    const attached = topStore(listSpy.mock.calls[0][0]);
    expect(attached).toBeDefined();
    // Rooted at the ref the SDK itself falls back to, so the injected store
    // reads the same directory the default one would have.
    expect(attached?.rootDir).toBe(`/state-root${process.cwd()}`);
    expect(res.sessions).toEqual([]);
  });

  it("keeps workspaces isolated, and reuses ONE instance per workspace", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({ cwd: "/w/iso-a", env: ENV });
    await adapter.newSession({ cwd: "/w/iso-b", env: ENV });
    await adapter.listSessions({ cwd: "/w/iso-a" });

    const a = nestedStore(createSpy.mock.calls[0][0]);
    const b = nestedStore(createSpy.mock.calls[1][0]);
    expect(a?.rootDir).toBe("/state-root/w/iso-a");
    expect(b?.rootDir).toBe("/state-root/w/iso-b");
    expect(a?.instanceId).not.toBe(b?.instanceId);
    // The SDK requires the SAME instance across create/resume/list for a root.
    expect(topStore(listSpy.mock.calls[0][0])?.instanceId).toBe(a?.instanceId);
  });
});

// ── wrapSdkWithLocalStore, directly ───────────────────────
// Shapes the adapter never produces on its own, plus the `localStore` surface
// readRunError() reads. Each test uses its own root so the wrapper's
// per-root memoization cannot leak between them.
describe("wrapSdkWithLocalStore", () => {
  let seq: number;
  let created: string[];

  function makeRaw(
    overrides: Partial<RawCursorSdk> = {},
  ): RawCursorSdk & { agent: { create: ReturnType<typeof vi.fn> } } {
    const create = vi.fn().mockResolvedValue({ agentId: "a" });
    const list = vi.fn().mockResolvedValue({ items: [] });
    const raw = {
      Agent: { create, resume: vi.fn(), list },
      JsonlLocalAgentStore: class {
        readonly instanceId = `s${++seq}`;
        readonly runs = { get: async () => ({ error: this.rootDir }) };
        constructor(readonly rootDir: string) {
          created.push(rootDir);
        }
      },
      getDefaultSdkStateRoot: (ref: string) => `/root${ref}`,
      ...overrides,
    } as unknown as RawCursorSdk;
    return Object.assign(raw, { agent: { create } }) as never;
  }

  beforeEach(() => {
    seq = 0;
    created = [];
  });

  it("leaves a caller-supplied store alone", async () => {
    // A store cannot cross the host's JSON bridge, so no real caller sends one —
    // the guard is what keeps a future in-process caller from being silently
    // overridden, so it is pinned rather than left to chance.
    const raw = makeRaw();
    const mine = { instanceId: "mine", rootDir: "/mine" };
    await wrapSdkWithLocalStore(raw).Agent.create({
      cwd: "/w/x",
      local: { store: mine },
    });
    expect(nestedStore(raw.agent.create.mock.calls[0][0])).toBe(mine);
    expect(created).toEqual([]); // never built one of ours
  });

  it("leaves a non-local Agent.list alone — a cloud listing has no local store", async () => {
    const raw = makeRaw();
    const list = raw.Agent.list as unknown as ReturnType<typeof vi.fn>;
    await wrapSdkWithLocalStore(raw).Agent.list({ runtime: "cloud" });
    expect(topStore(list.mock.calls[0][0])).toBeUndefined();
  });

  it("degrades to the SDK's own default when the store export is missing", async () => {
    // An @cursor/sdk predating JsonlLocalAgentStore must not make every call
    // throw from here; the SDK's default resolution is still there to try.
    const raw = makeRaw({ JsonlLocalAgentStore: undefined });
    await wrapSdkWithLocalStore(raw).Agent.create({ cwd: "/w/old" });
    expect(nestedStore(raw.agent.create.mock.calls[0][0])).toBeUndefined();
  });

  it("localStore.open honours an explicit stateRoot, bypassing getDefaultSdkStateRoot", async () => {
    const store = await wrapSdkWithLocalStore(makeRaw()).localStore!.open({
      workspaceRef: "/w/ignored",
      stateRoot: "/explicit/root",
    });
    expect((await store.runs.get({ agentId: "a", runId: "r" }))?.error).toBe(
      "/explicit/root",
    );
  });

  it("localStore.open reads as empty (never throws) when no store can be built", async () => {
    // Mirrors host-client's makeStore(null): readRunError must degrade to null
    // identically on both paths rather than blowing up a turn's error reporting.
    const raw = makeRaw({ JsonlLocalAgentStore: undefined });
    const store = await wrapSdkWithLocalStore(raw).localStore!.open({
      workspaceRef: "/w/none",
    });
    expect(await store.runs.get({ agentId: "a", runId: "r" })).toBeNull();
    await expect(store.dispose()).resolves.toBeUndefined();
  });

  it("hands localStore.open the SAME instance Agent.create writes through", async () => {
    const raw = makeRaw();
    const sdk = wrapSdkWithLocalStore(raw);
    await sdk.Agent.create({ cwd: "/w/same", local: { cwd: "/w/same" } });
    const store = await sdk.localStore!.open({ workspaceRef: "/w/same" });
    expect((await store.runs.get({ agentId: "a", runId: "r" }))?.error).toBe(
      "/root/w/same",
    );
    // Built once, not once per caller.
    expect(created).toEqual(["/root/w/same"]);
  });
});
