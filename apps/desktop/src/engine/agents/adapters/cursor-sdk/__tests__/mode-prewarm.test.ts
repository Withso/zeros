// @cursor/sdk keys its workspace executor on `autoReview` (together with cwd,
// apiKey, settingSources, sandbox and MCP), so "Auto" and "not Auto" are two
// SEPARATE executors — and building one is the full rules / skills / ignore /
// MCP walk, 8-12s on a repo this size.
//
// autoReview is also a CREATE-TIME option, so a mode change is reconciled by
// ensureAutoReview()'s `Agent.resume` on the next prompt. Before this, that
// resume asked for an executor nobody had built: the session-start prewarm had
// warmed the OTHER shape, so the whole walk landed inside the user's first
// message after they touched the mode picker.
//
// These lock the fix: the moment the desired shape changes, the build starts.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const {
  createSpy,
  resumeSpy,
  listSpy,
  modelsListSpy,
  prewarmSpy,
  sendSpy,
  usageSpy,
} = vi.hoisted(() => ({
  createSpy: vi.fn(),
  resumeSpy: vi.fn(),
  listSpy: vi.fn(),
  modelsListSpy: vi.fn(),
  prewarmSpy: vi.fn(),
  sendSpy: vi.fn(),
  usageSpy: vi.fn(),
}));

// The real in-process wrapper drops `platform` (only the subprocess host
// synthesizes that surface — host-client.ts). Pass it through so the adapter's
// prewarm path is reachable from a unit test.
vi.mock("../local-store", () => ({
  wrapSdkWithLocalStore: (raw: Record<string, unknown>) => ({
    ...raw,
    localStore: { open: async () => null },
  }),
}));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
  Cursor: { models: { list: modelsListSpy } },
  platform: { prewarm: prewarmSpy },
}));

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sessionToolsInventorySnapshotSchema } from "@zeros/protocol/agent-extensions";
import { CursorSdkAdapter } from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const fakeAgent = {
  agentId: "agent-xyz",
  send: sendSpy,
  getUsage: usageSpy,
  close: () => {},
};

let runSeq = 0;
const makeRun = () => ({
  id: `run-${++runSeq}`,
  stream: async function* (): AsyncGenerator<unknown, void> {
    /* no streamed events — the turn ends cleanly via wait() */
  },
  wait: async () => ({ status: "finished" }),
  cancel: async () => {},
});

const EMPTY_AGENT_USAGE = {
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  },
  cost: { rawCostCents: 0, chargedCents: 0 },
  runs: [],
};

const TEXT = [{ type: "text", text: "hi" }] as unknown as ContentBlock[];

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

/** `local` carries every executor-cache-key field the adapter controls
 *  (cwd, dirs, autoReview, sandbox, settingSources). autoReview=false is
 *  expressed by OMITTING the key — buildLocalOpts only sets it when true — so
 *  compare the whole object rather than one field. */
const localOf = (call: unknown[], index = 0): unknown =>
  (call[index] as { local?: unknown }).local;

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg"; // short-circuit ensureRipgrep
  process.env.ZEROS_CURSOR_IN_PROCESS = "1"; // take the direct SDK path
});

beforeEach(() => {
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  prewarmSpy.mockReset().mockResolvedValue({ prewarmed: true });
  sendSpy.mockReset().mockImplementation(async () => makeRun());
  usageSpy.mockReset().mockResolvedValue(EMPTY_AGENT_USAGE);
  runSeq = 0;
});
afterEach(() => vi.unstubAllEnvs());

async function startSession(): Promise<{
  adapter: CursorSdkAdapter;
  sessionId: string;
}> {
  const adapter = new CursorSdkAdapter(makeCtx());
  const { session } = await adapter.newSession({
    cwd: "/tmp/proj/wt",
    env: { CURSOR_API_KEY: "key_test" },
  });
  return { adapter, sessionId: session.executionId };
}

describe("Cursor executor prewarm across a mode change", () => {
  it("acknowledges the accepted mode so reconnects retain the latest selection", async () => {
    const ctx = makeCtx();
    const update = vi.fn();
    ctx.emit.onSessionUpdate = update;
    const adapter = new CursorSdkAdapter(ctx);
    try {
      const { session } = await adapter.newSession({ cwd: "/tmp/proj/wt", env: { CURSOR_API_KEY: "key_test" } });
      await adapter.setMode({ sessionId: session.executionId, modeId: "plan" });
      expect(update).toHaveBeenLastCalledWith("cursor", {
        sessionId: session.executionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: "plan" },
      });
      update.mockClear();
      await adapter.setMode({ sessionId: session.executionId, modeId: "unsupported" });
      expect(update).not.toHaveBeenCalled();
    } finally { await adapter.dispose(); }
  });

  it.each(["plan", "auto", "agent"])("starts and resumes the exact saved %s mode before sending", async mode => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const env = {CURSOR_API_KEY:"key_test",ZEROS_PERMISSION_MODE:mode};
    try {
      const {session} = await adapter.newSession({cwd:"/tmp/proj/wt",env});
      expect(session.modes?.currentModeId).toBe(mode);
      expect(createSpy.mock.calls[0]?.[0].mode).toBe(mode === "plan" ? "plan" : "agent");
      expect(!!createSpy.mock.calls[0]?.[0].local.autoReview).toBe(mode === "auto");
      const resumed = await adapter.loadSession({cwd:"/tmp/proj/wt",sessionId:"native",env});
      expect(resumed.modes?.currentModeId).toBe(mode);
      expect(!!resumeSpy.mock.calls[0]?.[1].local.autoReview).toBe(mode === "auto");
    } finally {await adapter.dispose();}
  });

  it("preserves SSE through creation, prewarm, mode recreation, and resume", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const mcpServers = [{ name: "reports", transport: "sse", url: "https://reports.example/events", headers: { "X-Version": "1" } }] as const;
    const expected = { reports: { type: "sse", url: mcpServers[0].url, headers: { "X-Version": "1" } } };
    try {
      const { session } = await adapter.newSession({ cwd: "/tmp/proj/wt", env: { CURSOR_API_KEY: "key_test" }, mcpServers: [...mcpServers] });
      expect(createSpy.mock.calls[0][0].mcpServers).toEqual(expected);
      expect(prewarmSpy.mock.calls[0][0].mcpServers).toEqual(expected);
      await adapter.setMode({ sessionId: session.executionId, modeId: "agent" });
      await adapter.prompt({ sessionId: session.executionId, prompt: TEXT });
      expect(resumeSpy.mock.calls.at(-1)![1].mcpServers).toEqual(expected);
      await adapter.loadSession({ sessionId: "saved-sse", cwd: "/tmp/proj/wt", env: { CURSOR_API_KEY: "key_test" }, mcpServers: [...mcpServers] });
      expect(resumeSpy.mock.calls.at(-1)![1].mcpServers).toEqual(expected);
    } finally {
      await adapter.dispose();
    }
  });

  it("reports every native settings layer as loaded for a Code chat", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const provenance =
      await adapter.capabilityPorts.configuration.readProvenance({
        cwd: "/tmp",
      });
    expect(
      provenance.sources
        .filter((source) => source.status === "loaded")
        .map((source) => source.id),
    ).toEqual(["user", "project", "team", "mdm", "plugins"]);
    expect(
      provenance.sources.filter((source) => source.status === "suppressed"),
    ).toEqual([]);
    await adapter.dispose();
  });

  it("warms the born-default Auto shape at session start", async () => {
    await startSession();
    expect(prewarmSpy).toHaveBeenCalledTimes(1);
    // CURSOR_DEFAULT_MODE is "auto", and autoReviewFor("auto") is true.
    expect(
      (localOf(prewarmSpy.mock.calls[0]) as { autoReview?: unknown })
        .autoReview,
    ).toBe(true);
  });

  it("warms exactly the executor ensureAutoReview's resume will ask for", async () => {
    const { adapter, sessionId } = await startSession();
    // The born-default warm is the Auto shape, and it sets autoReview.
    expect(
      (localOf(prewarmSpy.mock.calls[0]) as { autoReview?: unknown })
        .autoReview,
    ).toBe(true);
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId, modeId: "agent" });
    expect(prewarmSpy).toHaveBeenCalledTimes(1);

    // Now let the lazy reconcile run. THIS is the invariant that matters: the
    // options we warmed must be byte-for-byte the ones the resume presents, or
    // the SDK hashes a different cache key and warms an executor nobody uses.
    await adapter.prompt({ sessionId, prompt: TEXT });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(localOf(prewarmSpy.mock.calls[0])).toEqual(
      localOf(resumeSpy.mock.calls[0], 1),
    );
    const warmed = prewarmSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(warmed.cwd).toBe("/tmp/proj/wt");
    expect(warmed.apiKey).toBe("key_test");
  });

  it("loads Cursor's own settings layers at creation and prewarm", async () => {
    const { adapter } = await startSession();
    // Project and user rules, AGENTS.md, skills, plugins and locally declared
    // MCP load natively, as in the Cursor app.
    expect(
      (localOf(prewarmSpy.mock.calls[0]) as { settingSources?: unknown })
        .settingSources,
    ).toEqual(["project", "user", "team", "mdm", "plugins"]);
    expect(localOf(createSpy.mock.calls[0])).toEqual(
      localOf(prewarmSpy.mock.calls[0]),
    );
    expect(createSpy.mock.calls[0][0].mcpServers).toBeUndefined();
    await adapter.dispose();
  });

  it.each([
    ["http", false], ["http", true], ["sse", false], ["sse", true],
  ] as const)(
    "preserves native settings and imported %s MCP when reopening (missing agent: %s)",
    async (transport, missingAgent) => {
      if (missingAgent)
        resumeSpy.mockRejectedValueOnce(new Error("Agent agent-old not found"));
      const adapter = new CursorSdkAdapter(makeCtx());
      const imported = {
        name: "imported-server",
        transport,
        url: "https://example.com/mcp",
      };
      await adapter.loadSession({
        sessionId: "agent-old",
        cwd: "/tmp/proj/wt",
        env: { CURSOR_API_KEY: "key_test" },
        mcpServers: [imported],
      });
      const warmed = prewarmSpy.mock.calls[0][0];
      expect(warmed.local.settingSources).toEqual([
        "project",
        "user",
        "team",
        "mdm",
        "plugins",
      ]);
      expect(warmed.mcpServers).toEqual({
        "imported-server": { type: transport, url: imported.url },
      });
      expect(resumeSpy.mock.calls[0][1]).toMatchObject({
        local: warmed.local,
        mcpServers: warmed.mcpServers,
      });
      if (missingAgent)
        expect(createSpy.mock.calls[0][0]).toMatchObject({
          local: warmed.local,
          mcpServers: warmed.mcpServers,
        });
      await adapter.dispose();
    },
  );

  it("preserves a local server directory through prewarm, resume, and mode recreation", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const loaded = await adapter.loadSession({ sessionId: "agent-old", cwd: "/tmp/proj/wt",
      env: { CURSOR_API_KEY: "key_test" }, mcpServers: [{ name: "files", transport: "stdio", command: "node", args: ["server.js"], cwd: "tools" }] });
    const expected = { files: { command: "node", args: ["server.js"], cwd: "/tmp/proj/wt/tools" } };
    expect(prewarmSpy.mock.calls[0][0].mcpServers).toEqual(expected);
    expect(resumeSpy.mock.calls[0][1].mcpServers).toEqual(expected);
    await adapter.setMode({ sessionId: loaded.executionId!, modeId: "agent" });
    await adapter.prompt({ sessionId: loaded.executionId!, prompt: TEXT });
    expect(resumeSpy.mock.calls.at(-1)![1].mcpServers).toEqual(expected);
    await adapter.dispose();
  });

  it("keeps the host account opt-out across mode rebuilds", async () => {
    vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "0");
    const { adapter, sessionId } = await startSession();
    expect(localOf(createSpy.mock.calls[0])).toMatchObject({
      settingSources: [],
    });
    vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "1");
    await adapter.setMode({ sessionId, modeId: "agent" });
    await adapter.prompt({ sessionId, prompt: TEXT });
    expect(localOf(resumeSpy.mock.calls[0], 1)).toMatchObject({
      settingSources: [],
    });
    expect(localOf(prewarmSpy.mock.calls.at(-1)!)).toEqual(
      localOf(resumeSpy.mock.calls[0], 1),
    );
    await adapter.dispose();
  });

  it("preserves admitted extension sources when rebuilding for a mode change", async () => {
    const { adapter, sessionId } = await startSession();
    const admitted = localOf(createSpy.mock.calls[0]) as {
      settingSources: string[];
    };
    vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "0");
    await adapter.setMode({ sessionId, modeId: "agent" });
    await adapter.prompt({ sessionId, prompt: TEXT });
    expect(localOf(resumeSpy.mock.calls[0], 1)).toMatchObject({
      settingSources: admitted.settingSources,
    });
    expect(localOf(prewarmSpy.mock.calls.at(-1)!)).toEqual(
      localOf(resumeSpy.mock.calls[0], 1),
    );
    await adapter.dispose();
  });

  it("does not queue a second build while the first is still in flight", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId, modeId: "agent" });
    await adapter.setMode({ sessionId, modeId: "plan" }); // same autoReview=false
    await adapter.setMode({ sessionId, modeId: "agent" });

    expect(prewarmSpy).toHaveBeenCalledTimes(1);
  });

  it("does not rewarm the shape the live agent already has", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    // Back to the born default: the agent still carries autoReview=true, so
    // there is no rebuild coming and nothing to warm.
    await adapter.setMode({ sessionId, modeId: "auto" });

    expect(prewarmSpy).not.toHaveBeenCalled();
  });

  it("keeps a mode change instant when the prewarm is slow or fails", async () => {
    const { adapter, sessionId } = await startSession();
    let settle: (() => void) | undefined;
    prewarmSpy.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = () => resolve({ prewarmed: true });
        }),
    );

    // Fire-and-forget: setMode must not await the build.
    await expect(
      adapter.setMode({ sessionId, modeId: "agent" }),
    ).resolves.toBeUndefined();
    expect(settle).toBeDefined();
    settle?.();

    // And a rejected prewarm is swallowed — it is a pure optimization, the
    // send rebuilds. An unhandled rejection here would take the engine down.
    prewarmSpy.mockReset().mockRejectedValue(new Error("host gone"));
    const { adapter: other, sessionId: otherId } = await startSession();
    await expect(
      other.setMode({ sessionId: otherId, modeId: "plan" }),
    ).resolves.toBeUndefined();
    await Promise.resolve();
  });

  it("is a no-op on an unknown session and on an unrecognized mode", async () => {
    const { adapter, sessionId } = await startSession();
    prewarmSpy.mockClear();

    await adapter.setMode({ sessionId: "nope", modeId: "agent" });
    await adapter.setMode({ sessionId, modeId: "not-a-mode" });

    expect(prewarmSpy).not.toHaveBeenCalled();
  });
});

describe("Cursor session tools", () => {
  async function withCursorConfigs(
    run: (workspace: string) => Promise<void>,
  ): Promise<void> {
    const home = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-home-"));
    const workspace = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-ws-"));
    const write = async (root: string, servers: Record<string, unknown>) => {
      await mkdir(path.join(root, ".cursor"), { recursive: true });
      await writeFile(
        path.join(root, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: servers }),
      );
    };
    try {
      // The provider home is this process's HOME for an uncontained session.
      vi.stubEnv("HOME", home);
      await write(home, { "home-tools": { url: "https://example.test/home" } });
      await write(workspace, {
        "repo-tools": { command: "node", args: ["server.js"] },
        imported: { url: "https://example.test/imported" },
      });
      await run(workspace);
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }
  const imported = {
    name: "imported",
    transport: "http" as const,
    url: "https://example.test/imported",
  };

  it("lists MCP servers from Cursor's own settings in the Local folder", async () => {
    await withCursorConfigs(async (workspace) => {
      const adapter = new CursorSdkAdapter(makeCtx());
      try {
        const { session } = await adapter.newSession({
          cwd: workspace,
          env: { CURSOR_API_KEY: "key_test" },
          mcpServers: [imported],
        });
        const sessionId = session.executionId;
        const inventory =
          await adapter.capabilityPorts.sessionTools.inventory({ sessionId });
        expect(
          inventory.groups
            ?.find((group) => group.kind === "mcp")
            ?.entries.map((entry) => [entry.name, entry.status, entry.source]),
        ).toEqual([
          ["imported", "error", undefined],
          ["home-tools", "unverified", "local"],
          ["repo-tools", "unverified", "local"],
        ]);
        // The strict legacy list carries only the admitted registry.
        const list = await adapter.capabilityPorts.sessionTools.list({ sessionId });
        expect(list.entries.map((entry) => entry.name)).toEqual(["imported"]);
      } finally {
        await adapter.dispose();
      }
    });
  });

  it("lists no Local servers when the host opt-out keeps native settings off", async () => {
    await withCursorConfigs(async (workspace) => {
      vi.stubEnv("ZEROS_NATIVE_MCP_PASSTHROUGH", "0");
      const adapter = new CursorSdkAdapter(makeCtx());
      try {
        const { session } = await adapter.newSession({
          cwd: workspace,
          env: { CURSOR_API_KEY: "key_test" },
          mcpServers: [imported],
        });
        const inventory = await adapter.capabilityPorts.sessionTools.inventory({
          sessionId: session.executionId,
        });
        expect(
          inventory.groups
            ?.find((group) => group.kind === "mcp")
            ?.entries.map((entry) => entry.name),
        ).toEqual(["imported"]);
      } finally {
        await adapter.dispose();
      }
    });
  });

  it("keeps long local server names within the inventory wire limits", async () => {
    await withCursorConfigs(async (workspace) => {
      const prefix = "x".repeat(512);
      await writeFile(path.join(workspace, ".cursor", "mcp.json"), JSON.stringify({
        mcpServers: {
          [prefix + "a"]: { command: "node" },
          [prefix + "b"]: { command: "node" },
        },
      }));
      const adapter = new CursorSdkAdapter(makeCtx());
      try {
        const { session } = await adapter.newSession({
          cwd: workspace,
          env: { CURSOR_API_KEY: "key_test" },
        });
        const inventory = await adapter.capabilityPorts.sessionTools.inventory({ sessionId: session.executionId });
        expect(sessionToolsInventorySnapshotSchema.safeParse(inventory).success).toBe(true);
        const entries = inventory.groups.find(group => group.kind === "mcp")!.entries;
        expect(entries).toHaveLength(3);
        expect(new Set(entries.map(entry => entry.id)).size).toBe(3);
      } finally {
        await adapter.dispose();
      }
    });
  });
});
