// Locks two Cursor model fixes:
//  1. "Local SDK agents require an explicit `model`" — the SDK resolves a
//     run's model as `sendOptions.model ?? agent._model`; a resumed agent's
//     `_model` can be undefined, so the adapter MUST pass `model` on BOTH
//     `Agent.resume` and `agent.send`.
//  2. "Cannot use this model: composer-2-fast. Available models: …" — the old
//     default `composer-2-fast` isn't in current accounts' catalogs. The
//     default is now `composer-2.5`, and any pick is validated against the
//     live `Cursor.models.list()` catalog (resolveValidModelId) before spawn.

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CursorSdkAdapter,
  resolveValidModelId,
  applyCursorReasoning,
  isCursorModelGatedError,
} from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const { createSpy, resumeSpy, sendSpy, listSpy, modelsListSpy, storeGetSpy } =
  vi.hoisted(() => ({
    createSpy: vi.fn(),
    resumeSpy: vi.fn(),
    sendSpy: vi.fn(),
    listSpy: vi.fn(),
    modelsListSpy: vi.fn(),
    storeGetSpy: vi.fn(),
  }));

vi.mock("@cursor/sdk", () => ({
  Agent: { create: createSpy, resume: resumeSpy, list: listSpy },
  Cursor: { models: { list: modelsListSpy } },
  // The REAL @cursor/sdk surface: a JsonlLocalAgentStore constructor plus
  // getDefaultSdkStateRoot. Mocking a `LocalAgentStore.open` namespace (as this
  // did) rubber-stamped a name the package has never exported, so the in-process
  // store path looked covered while it could not work at all.
  JsonlLocalAgentStore: class {
    runs = { get: storeGetSpy };
    constructor(readonly rootDir: string) {}
  },
  getDefaultSdkStateRoot: (workspaceRef: string) => `/state-root${workspaceRef}`,
}));

let runSeq = 0;
const makeRun = (status = "finished") => ({
  id: `run-${++runSeq}`,
  stream: async function* (): AsyncGenerator<unknown, void> {
    /* no streamed events — turn ends cleanly via wait() */
  },
  wait: async () => ({ status }),
  cancel: async () => {},
});

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
  delete process.env.CURSOR_API_KEY; // avoid initialize()'s background discovery
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  sendSpy.mockReset().mockImplementation(async () => makeRun());
  listSpy.mockReset().mockResolvedValue({ items: [] });
  // Default: no catalog discovered → adapter uses the static default and
  // trusts picks (the SDK still validates server-side).
  modelsListSpy.mockReset().mockResolvedValue([]);
  storeGetSpy.mockReset().mockResolvedValue(null);
  runSeq = 0;
});

const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("resolveValidModelId (pure)", () => {
  it("trusts the id when the catalog is undiscovered (null)", () => {
    expect(resolveValidModelId("composer-2-fast", null)).toBe(
      "composer-2-fast",
    );
  });
  it("keeps a valid id", () => {
    expect(
      resolveValidModelId(
        "composer-2",
        new Set(["composer-2.5", "composer-2"]),
      ),
    ).toBe("composer-2");
  });
  it("falls back off a stale id to the preferred concrete model", () => {
    expect(
      resolveValidModelId(
        "composer-2-fast",
        new Set(["composer-2.5", "composer-2", "gpt-5.5"]),
      ),
    ).toBe("composer-2.5");
  });
  it("falls back to any Composer model when no preference matches", () => {
    expect(
      resolveValidModelId("bogus", new Set(["composer-9", "gpt-5.5"])),
    ).toBe("composer-9");
  });
});

describe("applyCursorReasoning (pure) — Effort/Fast pills swap to a variant id", () => {
  // Cursor bakes reasoning + speed into the MODEL ID (no separate SDK field),
  // so the composer's Effort/Fast pills can only take effect by swapping to a
  // concrete variant the account offers. This helper is SPECULATIVE + safe: it
  // can only ever return the base id or a variant proven to be in `available`.
  it("returns the base UNCHANGED when the catalog is undiscovered (null)", () => {
    // Can't prove any variant exists → never risk an unoffered id.
    expect(applyCursorReasoning("grok-4.5", "high", true, null)).toBe(
      "grok-4.5",
    );
  });

  it("returns the base UNCHANGED when nothing in the catalog matches a candidate", () => {
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "high",
        true,
        new Set(["grok-4.5", "composer-2.5"]),
      ),
    ).toBe("grok-4.5");
  });

  it("never STACKS reasoning suffixes onto an id that already encodes them", () => {
    // §3.6 R1 relaxed the old blanket guard: an explicit DIFFERENT level now
    // RE-TARGETS a level-suffixed base (see the retarget test below). What
    // must still never happen is stacking a second suffix or synthesizing an
    // unoffered id.
    // Same level requested → nothing to change.
    expect(
      applyCursorReasoning(
        "grok-4.5-thinking-high",
        "high",
        false,
        new Set([
          "grok-4.5-thinking-high",
          "grok-4.5-thinking-high-thinking-high",
        ]),
      ),
    ).toBe("grok-4.5-thinking-high");
    // A different level with NO matching id in the catalog → stays put.
    expect(
      applyCursorReasoning(
        "grok-4.5-thinking-high",
        "low",
        false,
        new Set(["grok-4.5-thinking-high"]),
      ),
    ).toBe("grok-4.5-thinking-high");
    // A -fast base never gains a second -fast.
    expect(
      applyCursorReasoning(
        "composer-2.5-fast",
        undefined,
        true,
        new Set(["composer-2.5-fast-fast"]),
      ),
    ).toBe("composer-2.5-fast");
    // A level-suffixed base with fast on but NO fast twin in the catalog
    // stays put (never synthesize an unoffered id).
    expect(
      applyCursorReasoning(
        "grok-4.5-xhigh",
        undefined,
        true,
        new Set(["grok-4.5-xhigh"]),
      ),
    ).toBe("grok-4.5-xhigh");
  });

  it("§3.6 R1 — an explicit level RE-TARGETS a level-suffixed base (persisted pre-v6 picks)", () => {
    // The persisted flagship pick grok-4.5-xhigh + the pill's Medium →
    // the catalog's medium id, not a silently-ignored pick.
    expect(
      applyCursorReasoning(
        "grok-4.5-xhigh",
        "medium",
        false,
        new Set(["grok-4.5-xhigh", "grok-4.5-thinking-medium"]),
      ),
    ).toBe("grok-4.5-thinking-medium");
    // Bare-level shape works too.
    expect(
      applyCursorReasoning(
        "grok-4.5-xhigh",
        "low",
        false,
        new Set(["grok-4.5-xhigh", "grok-4.5-low"]),
      ),
    ).toBe("grok-4.5-low");
    // A -thinking-<level> base re-targets on its stem (no -thinking-thinking-).
    expect(
      applyCursorReasoning(
        "grok-4.5-thinking-high",
        "low",
        false,
        new Set(["grok-4.5-thinking-low", "grok-4.5-thinking-high"]),
      ),
    ).toBe("grok-4.5-thinking-low");
    // Fast + retarget prefers the fast+level shapes.
    expect(
      applyCursorReasoning(
        "grok-4.5-xhigh",
        "medium",
        true,
        new Set([
          "grok-4.5-fast-medium",
          "grok-4.5-thinking-medium",
          "grok-4.5-fast-xhigh",
        ]),
      ),
    ).toBe("grok-4.5-fast-medium");
  });

  it("fast on a LEVEL-suffixed base swaps to its verified fast twin (both shapes)", () => {
    // Grok's scheme (verified via `cursor-agent models` 2026-07-10): -fast
    // inserts BEFORE the trailing level.
    expect(
      applyCursorReasoning(
        "grok-4.5-xhigh",
        undefined,
        true,
        new Set(["grok-4.5-xhigh", "grok-4.5-fast-xhigh"]),
      ),
    ).toBe("grok-4.5-fast-xhigh");
    // Opus/Sol's scheme: -fast APPENDS after the level.
    expect(
      applyCursorReasoning(
        "claude-opus-4-8-thinking-high",
        undefined,
        true,
        new Set(["claude-opus-4-8-thinking-high-fast"]),
      ),
    ).toBe("claude-opus-4-8-thinking-high-fast");
  });

  it("prefers the most specific (fast + level) variant, then falls back through the shapes", () => {
    // Both the fast+level and the level-only variants exist → the fast+level wins.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "high",
        true,
        new Set(["grok-4.5-thinking-high-fast", "grok-4.5-thinking-high"]),
      ),
    ).toBe("grok-4.5-thinking-high-fast");
    // Only the alternate fast+level shape exists.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "medium",
        true,
        new Set(["grok-4.5-fast-medium"]),
      ),
    ).toBe("grok-4.5-fast-medium");
  });

  it("applies fast alone (no effort) when only a -fast variant exists", () => {
    expect(
      applyCursorReasoning(
        "composer-2.5",
        undefined,
        true,
        new Set(["composer-2.5-fast"]),
      ),
    ).toBe("composer-2.5-fast");
  });

  it("applies effort alone (no fast) via -thinking-<level> then -<level>", () => {
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "low",
        false,
        new Set(["grok-4.5-thinking-low"]),
      ),
    ).toBe("grok-4.5-thinking-low");
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "high",
        false,
        new Set(["grok-4.5-high"]),
      ),
    ).toBe("grok-4.5-high");
  });

  it("treats non-low/medium/high effort (xhigh/max/ultra) as no level", () => {
    // Only low/medium/high are real Cursor reasoning levels; anything else → no
    // level candidate, so with fast off (and the bare base live in the
    // catalog) there's nothing to swap to.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "xhigh",
        false,
        new Set(["grok-4.5", "grok-4.5-thinking-xhigh"]),
      ),
    ).toBe("grok-4.5");
  });

  // §3.6 R1 (2026-07-13) — the curated Grok base is the LEVEL-FREE grok-4.5,
  // which is NOT itself a live id. When no level/fast candidate lands and the
  // bare base isn't offered, it completes to the model's top tier instead of
  // leaking a dead id (which resolveValidModelId would then punt to Composer).
  it("completes a non-live level-free base to its top tier (id-completion)", () => {
    // No effort, fast off → the -xhigh flagship.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        undefined,
        false,
        new Set(["grok-4.5-xhigh"]),
      ),
    ).toBe("grok-4.5-xhigh");
    // Fast on → the verified fast flagship shape wins.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        undefined,
        true,
        new Set(["grok-4.5-xhigh", "grok-4.5-fast-xhigh"]),
      ),
    ).toBe("grok-4.5-fast-xhigh");
    // A real level pick still beats completion.
    expect(
      applyCursorReasoning(
        "grok-4.5",
        "high",
        false,
        new Set(["grok-4.5-thinking-high", "grok-4.5-xhigh"]),
      ),
    ).toBe("grok-4.5-thinking-high");
    // A live bare base never completes (nothing to fix).
    expect(
      applyCursorReasoning(
        "grok-4.5",
        undefined,
        false,
        new Set(["grok-4.5", "grok-4.5-xhigh"]),
      ),
    ).toBe("grok-4.5");
  });
});

describe("CursorSdkAdapter — model is always passed AND validated", () => {
  it("passes the resolved default (composer-2.5) to send() on a fresh session", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, opts] = sendSpy.mock.calls[0];
    expect(opts).toMatchObject({
      mode: "agent",
      model: { id: "composer-2.5" },
    });
  });

  it("binds model on Agent.resume() so resumed chats don't throw 'explicit model'", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.loadSession({
      sessionId: "prior-agent-id",
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2" },
    });

    expect(resumeSpy).toHaveBeenCalledTimes(1);
    const [agentId, opts] = resumeSpy.mock.calls[0];
    expect(agentId).toBe("prior-agent-id");
    expect(opts).toMatchObject({ model: { id: "composer-2" } });
  });

  it("VALIDATES against the live catalog: a stale CURSOR_MODEL falls back instead of throwing", async () => {
    // The account's real catalog (no composer-2-fast).
    modelsListSpy.mockResolvedValue([
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "composer-2", displayName: "Composer 2" },
      { id: "gpt-5.5", displayName: "GPT-5.5" },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2-fast" },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    // create() and send() must receive a VALID model, not the stale pick.
    const [createOpts] = createSpy.mock.calls[0];
    expect(createOpts).toMatchObject({ model: { id: "composer-2.5" } });
    const [, sendOpts] = sendSpy.mock.calls[0];
    expect(sendOpts.model).toEqual({ id: "composer-2.5" });
  });
});

describe("Cursor modes — Ask / Auto / Full access + autoReview rebuild", () => {
  const NEW = { cwd: "/tmp/proj", env: { CURSOR_API_KEY: "key_test" } };

  it("a fresh session is born in Auto: create gets autoReview:true, advertises the 3 modes", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession(NEW);
    const [createOpts] = createSpy.mock.calls[0];
    // Auto = sdk mode "agent" + create-time autoReview.
    expect(createOpts).toMatchObject({
      mode: "agent",
      local: { autoReview: true },
    });
    expect(session.modes?.currentModeId).toBe("auto");
    expect(
      session.modes?.availableModes.map((m: { id: string }) => m.id),
    ).toEqual(["plan", "auto", "agent"]);
  });

  it("maps each Zeros mode to the sdk mode on send (plan→plan, auto/agent→agent)", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession(NEW);
    const id = session.sessionId;

    await adapter.prompt({ sessionId: id, prompt: TEXT }); // default Auto
    expect(sendSpy.mock.calls[0][1]).toMatchObject({ mode: "agent" });

    await adapter.setMode({ sessionId: id, modeId: "plan" }); // Ask
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(sendSpy.mock.calls[1][1]).toMatchObject({ mode: "plan" });

    await adapter.setMode({ sessionId: id, modeId: "agent" }); // Full access
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(sendSpy.mock.calls[2][1]).toMatchObject({ mode: "agent" });
  });

  it("rebuilds the agent (Agent.resume) ONLY when the autoReview gate flips", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession(NEW); // Auto → applied autoReview:true
    const id = session.sessionId;
    resumeSpy.mockClear();

    // Auto → Full access: autoReview true→false → one rebuild (autoReview omitted).
    await adapter.setMode({ sessionId: id, modeId: "agent" });
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy.mock.calls[0][0]).toBe(id); // same session id — history preserved
    expect(resumeSpy.mock.calls[0][1].local).not.toHaveProperty("autoReview");

    // Prompt again, same mode → no further rebuild.
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // Full access → Ask: both autoReview off → still no rebuild, just a mode swap.
    await adapter.setMode({ sessionId: id, modeId: "plan" });
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // Ask → Auto: autoReview false→true → rebuild with autoReview:true.
    await adapter.setMode({ sessionId: id, modeId: "auto" });
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(resumeSpy).toHaveBeenCalledTimes(2);
    expect(resumeSpy.mock.calls[1][1].local).toMatchObject({
      autoReview: true,
    });
  });

  it("a failed rebuild keeps the turn alive (old agent retained, retried next prompt)", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession(NEW);
    const id = session.sessionId;
    resumeSpy.mockClear().mockRejectedValueOnce(new Error("resume boom"));

    await adapter.setMode({ sessionId: id, modeId: "agent" });
    // Rebuild throws internally but the prompt still sends (best-effort gate).
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(sendSpy).toHaveBeenCalled();

    // appliedAutoReview stayed stale → next prompt retries the rebuild.
    resumeSpy.mockResolvedValue(fakeAgent);
    await adapter.prompt({ sessionId: id, prompt: TEXT });
    expect(resumeSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("isCursorModelGatedError (pure)", () => {
  it("matches model/Max-Mode gating reasons", () => {
    for (const m of [
      "This model requires Max Mode, which isn't available on your plan.",
      "Cannot use this model: gpt-5.5. Available models: …",
      "unsupported model",
      "The model claude-opus-4-7 is not available for local agents.",
    ]) {
      expect(isCursorModelGatedError(m)).toBe(true);
    }
  });

  it("does NOT match auth / network / transient failures (those shouldn't retry a different model)", () => {
    for (const m of [
      "unauthenticated",
      "Invalid API key",
      "NGHTTP2_FRAME_SIZE_ERROR",
      "connection reset",
      "Agent abc not found",
    ]) {
      expect(isCursorModelGatedError(m)).toBe(false);
    }
  });
});

describe("CursorSdkAdapter — reject-recovery on a model the account can't run", () => {
  it("reads the store's real error, then retries once with a confirmed-good model", async () => {
    // Account catalog includes composer-2.5 (so it's the picked default) AND
    // composer-2 (the retry target).
    modelsListSpy.mockResolvedValue([
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "composer-2", displayName: "Composer 2" },
    ]);
    // First run errors (detail-less wait); second run succeeds.
    sendSpy
      .mockImplementationOnce(async () => makeRun("error"))
      .mockImplementationOnce(async () => makeRun("finished"));
    // The store holds the REAL reason wait() hides — a Max-Mode gate.
    storeGetSpy.mockResolvedValue({
      status: "error",
      error: "This model requires Max Mode, unavailable on your plan.",
    });

    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2.5" },
    });
    // Should NOT throw — the retry recovers the turn.
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(sendSpy.mock.calls[0][1].model).toEqual({ id: "composer-2.5" });
    expect(sendSpy.mock.calls[1][1].model).toEqual({ id: "composer-2" }); // fallback
    // The store was consulted to recover the real reason.
    expect(storeGetSpy).toHaveBeenCalled();
  });

  it("does NOT retry (and surfaces the real error) when the failure isn't model-gated", async () => {
    modelsListSpy.mockResolvedValue([
      { id: "composer-2.5", displayName: "Composer 2.5" },
      { id: "composer-2", displayName: "Composer 2" },
    ]);
    sendSpy.mockImplementation(async () => makeRun("error"));
    storeGetSpy.mockResolvedValue({
      status: "error",
      error: "unauthenticated: invalid API key",
    });

    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2.5" },
    });
    await expect(
      adapter.prompt({ sessionId: session.sessionId, prompt: TEXT }),
    ).rejects.toMatchObject({
      // classifyCursorSdkError routes "unauthenticated"/"api key" → auth-required.
      failure: { kind: "auth-required" },
    });
    // No wasted retry on a non-model failure.
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });
});
