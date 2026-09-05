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
import path from "node:path";

import {
  CursorSdkAdapter,
  resolveValidModelId,
  applyCursorReasoning,
  isCursorModelGatedError,
  cursorAgentUsageDelta,
  cursorAdvertisedModel,
  cursorModelStateFingerprint,
  cursorRipgrepPathFromEnvironment,
  parseCursorAdditionalDirs,
} from "../adapter";
import type { AgentAdapterContext, ContentBlock } from "../../../types";

const {
  createSpy,
  resumeSpy,
  sendSpy,
  listSpy,
  modelsListSpy,
  storeGetSpy,
  usageSpy,
} = vi.hoisted(() => ({
  createSpy: vi.fn(),
  resumeSpy: vi.fn(),
  sendSpy: vi.fn(),
  listSpy: vi.fn(),
  modelsListSpy: vi.fn(),
  storeGetSpy: vi.fn(),
  usageSpy: vi.fn(),
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
  getDefaultSdkStateRoot: (workspaceRef: string) =>
    `/state-root${workspaceRef}`,
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

const fakeAgent = {
  agentId: "agent-xyz",
  send: sendSpy,
  getUsage: usageSpy,
  close: () => {},
};

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
  usageSpy.mockReset().mockResolvedValue(EMPTY_AGENT_USAGE);
  runSeq = 0;
});

const TEXT: ContentBlock[] = [{ type: "text", text: "hi" } as ContentBlock];

describe("cursorModelStateFingerprint (pure)", () => {
  it("uses the process salt when pseudonymizing account credentials", async () => {
    const firstProcessSalt = new Uint8Array(32).fill(0x11);
    const secondProcessSalt = new Uint8Array(32).fill(0x22);
    const apiKey = "key_account_a";

    const fingerprint = await cursorModelStateFingerprint(
      apiKey,
      firstProcessSalt,
    );

    expect(fingerprint).toBe(
      await cursorModelStateFingerprint(apiKey, firstProcessSalt),
    );
    expect(fingerprint).not.toBe(
      await cursorModelStateFingerprint(apiKey, secondProcessSalt),
    );
    expect(fingerprint).not.toBe(
      await cursorModelStateFingerprint("key_account_b", firstProcessSalt),
    );
  });
});

describe("cursorRipgrepPathFromEnvironment (packaged host)", () => {
  it("reuses the staged ZSR binary when Cursor has no separate path", () => {
    expect(
      cursorRipgrepPathFromEnvironment({
        ZEROS_ZSR_RIPGREP_PATH: "/Applications/Zeros.app/Resources/zsr-rg",
      }),
    ).toBe("/Applications/Zeros.app/Resources/zsr-rg");
  });

  it("keeps an explicit Cursor path and rejects a relative staged path", () => {
    expect(
      cursorRipgrepPathFromEnvironment({
        CURSOR_RIPGREP_PATH: "/custom/rg",
        ZEROS_ZSR_RIPGREP_PATH: "/staged/rg",
      }),
    ).toBe("/custom/rg");
    expect(
      cursorRipgrepPathFromEnvironment({ ZEROS_ZSR_RIPGREP_PATH: "zsr-rg" }),
    ).toBeNull();
  });
});

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

describe("cursorAdvertisedModel capability presence", () => {
  it("preserves an explicit empty live effort definition", () => {
    expect(
      cursorAdvertisedModel({
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [{ id: "effort", values: [] }],
      }),
    ).toMatchObject({ effortLevels: [] });
  });

  it("omits effortLevels only when live discovery has no effort answer", () => {
    expect(
      cursorAdvertisedModel({
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
      }),
    ).not.toHaveProperty("effortLevels");
  });
});

describe("CursorSdkAdapter — provider-neutral initialization", () => {
  it("does not start SDK work merely because the engine inherited a key", async () => {
    process.env.CURSOR_API_KEY = "key_must_remain_idle";
    const adapter = new CursorSdkAdapter(makeCtx());

    await adapter.initialize();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(modelsListSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
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
    // The model-selection rule allows an explicit different level to
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

  it("an explicit level retargets a level-suffixed base from persisted pre-v6 picks", () => {
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

  it("maps xhigh exactly while still rejecting non-Cursor max/ultracode tiers", () => {
    expect(
      applyCursorReasoning(
        "grok-4.6",
        "xhigh",
        false,
        new Set(["grok-4.6", "grok-4.6-thinking-xhigh"]),
      ),
    ).toBe("grok-4.6-thinking-xhigh");
    expect(
      applyCursorReasoning(
        "grok-4.6",
        "ultracode",
        false,
        new Set(["grok-4.6", "grok-4.6-thinking-ultracode"]),
      ),
    ).toBe("grok-4.6");
  });

  // The curated Grok base is the level-free grok-4.5,
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
  it("preserves cold Auto and its Fast request instead of coercing to Composer", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "auto",
        ZEROS_FAST_MODE: "1",
        ZEROS_THINKING_EFFORT: "xhigh",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(createSpy.mock.calls[0][0].model).toEqual({
      id: "auto",
      params: [{ id: "fast", value: "true" }],
    });
    expect(sendSpy.mock.calls[0][1].model).toEqual({
      id: "auto",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("maps live Auto to Cursor's canonical default without carrying Grok effort", async () => {
    modelsListSpy.mockResolvedValue([
      {
        id: "default",
        displayName: "Auto",
        aliases: ["auto"],
        variants: [{ displayName: "Auto", params: [], isDefault: true }],
      },
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [
          {
            id: "effort",
            values: [
              { value: "low" },
              { value: "medium" },
              { value: "high" },
              { value: "xhigh" },
            ],
          },
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        ],
        variants: [
          {
            displayName: "Cursor Grok 4.6",
            params: [
              { id: "effort", value: "high" },
              { id: "fast", value: "false" },
            ],
            isDefault: true,
          },
        ],
      },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "auto",
        ZEROS_FAST_MODE: "1",
        ZEROS_THINKING_EFFORT: "xhigh",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(createSpy.mock.calls[0][0].model).toEqual({
      id: "default",
      params: [{ id: "fast", value: "true" }],
    });
    expect(sendSpy.mock.calls[0][1].model).toEqual({
      id: "default",
      params: [{ id: "fast", value: "true" }],
    });
    const auto = (await adapter.initialize())._meta?.models?.find(
      (model) => model.value === "default",
    );
    expect(auto).toMatchObject({
      value: "default",
      label: "Auto",
      selectable: true,
    });
    expect(auto).not.toHaveProperty("effortLevels");
    expect(
      (await adapter.initialize())._meta?.models?.find(
        (model) => model.value === "grok-4.6",
      ),
    ).toMatchObject({
      effortLevels: ["low", "medium", "high", "xhigh"],
      supportsFast: true,
    });
  });

  it("lets an explicit live empty Grok effort definition override the curated cold fallback", async () => {
    modelsListSpy.mockResolvedValue([
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [
          { id: "effort", values: [] },
          { id: "fast", values: [{ value: "false" }] },
        ],
      },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "grok-4.6",
        ZEROS_THINKING_EFFORT: "xhigh",
        ZEROS_FAST_MODE: "1",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(createSpy.mock.calls[0][0].model).toEqual({ id: "grok-4.6" });
    expect(sendSpy.mock.calls[0][1].model).toEqual({ id: "grok-4.6" });
    expect(
      (await adapter.initialize())._meta?.models?.find(
        (model) => model.value === "grok-4.6",
      ),
    ).toMatchObject({ effortLevels: [], supportsFast: false });
  });

  it("fills both unknown Grok capabilities when an exact live record has no parameter metadata", async () => {
    modelsListSpy.mockResolvedValue([
      { id: "grok-4.6", displayName: "Cursor Grok 4.6" },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "grok-4.6",
        ZEROS_THINKING_EFFORT: "xhigh",
        ZEROS_FAST_MODE: "1",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    const expected = {
      id: "grok-4.6",
      params: [
        { id: "effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    };
    expect(createSpy.mock.calls[0][0].model).toEqual(expected);
    expect(sendSpy.mock.calls[0][1].model).toEqual(expected);
    expect(
      (await adapter.initialize())._meta?.models?.find(
        (model) => model.value === "grok-4.6",
      ),
    ).not.toHaveProperty("effortLevels");
  });

  it.each([
    {
      name: "effort is explicitly empty but Fast is unknown",
      parameters: [{ id: "effort", values: [] }],
      expectedParams: [{ id: "fast", value: "true" }],
    },
    {
      name: "Fast is explicitly unsupported but effort is unknown",
      parameters: [{ id: "fast", values: [{ value: "false" }] }],
      expectedParams: [{ id: "effort", value: "xhigh" }],
    },
  ])("fills only the unknown Grok capability when $name", async (fixture) => {
    modelsListSpy.mockResolvedValue([
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: fixture.parameters,
      },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "grok-4.6",
        ZEROS_THINKING_EFFORT: "xhigh",
        ZEROS_FAST_MODE: "1",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    const expected = { id: "grok-4.6", params: fixture.expectedParams };
    expect(createSpy.mock.calls[0][0].model).toEqual(expected);
    expect(sendSpy.mock.calls[0][1].model).toEqual(expected);
  });

  it("maps Grok 4.6 effort and Fast to SDK params on create, send, and resume", async () => {
    modelsListSpy.mockResolvedValue([
      {
        id: "grok-4.6",
        displayName: "Cursor Grok 4.6",
        parameters: [
          {
            id: "effort",
            values: [
              { value: "low" },
              { value: "medium" },
              { value: "high" },
              { value: "xhigh" },
            ],
          },
          { id: "fast", values: [{ value: "false" }, { value: "true" }] },
        ],
        variants: [
          {
            displayName: "Cursor Grok 4.6",
            params: [
              { id: "effort", value: "high" },
              { id: "fast", value: "false" },
            ],
            isDefault: true,
          },
        ],
      },
    ]);
    const env = {
      CURSOR_API_KEY: "key_test",
      CURSOR_MODEL: "grok-4.6",
      ZEROS_THINKING_EFFORT: "xhigh",
      ZEROS_FAST_MODE: "1",
    };
    const adapter = new CursorSdkAdapter(makeCtx());
    const fresh = await adapter.newSession({ cwd: "/tmp/proj", env });
    await adapter.prompt({ sessionId: fresh.session.sessionId, prompt: TEXT });
    await adapter.loadSession({
      executionId: "resumed-grok-46",
      sessionId: "prior-grok-46",
      cwd: "/tmp/proj",
      env,
    });

    const expected = {
      id: "grok-4.6",
      params: [
        { id: "effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    };
    expect(createSpy.mock.calls[0][0].model).toEqual(expected);
    expect(sendSpy.mock.calls[0][1].model).toEqual(expected);
    expect(resumeSpy.mock.calls.at(-1)?.[1].model).toEqual(expected);
  });

  it("keeps a saved default Router selection instead of silently choosing Composer", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.loadSession({
      sessionId: "saved-router",
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "default" },
    });
    expect(resumeSpy.mock.calls[0][1].model).toEqual({ id: "default" });
  });

  it("passes the resolved default (composer-2.5) to send() on a fresh session", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    const completed = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const [, opts] = sendSpy.mock.calls[0];
    expect(opts).toMatchObject({
      mode: "agent",
      model: { id: "composer-2.5" },
    });
    expect(completed.response.effectiveModel).toBe("composer-2.5");
    expect(sendSpy.mock.calls[0][1].idempotencyKey).toMatch(/^zeros-/);
  });

  it("uses the engine-owned turn identity for a stable provider idempotency key", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    await adapter.prompt({
      sessionId: session.sessionId,
      turnId: "user-message-42",
      prompt: TEXT,
    });

    const key = sendSpy.mock.calls[0][1].idempotencyKey;
    expect(key).toMatch(/^zeros-[a-f0-9]{32}$/);
    expect(key).not.toContain("user-message-42");
  });

  it("keeps the same provider idempotency key after the execution is recovered", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const first = await adapter.newSession({
      executionId: "execution-before-recovery",
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    await adapter.prompt({
      sessionId: first.session.sessionId,
      turnId: "user-message-retried",
      prompt: TEXT,
    });
    const firstKey = sendSpy.mock.calls[0][1].idempotencyKey;

    const recovered = await adapter.loadSession({
      executionId: "execution-after-recovery",
      providerBinding: {
        version: 1,
        kind: "native",
        providerId: "cursor",
        resumeId: "agent-xyz",
      },
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    await adapter.prompt({
      sessionId: recovered.executionId!,
      turnId: "user-message-retried",
      prompt: TEXT,
    });

    expect(sendSpy.mock.calls[1][1].idempotencyKey).toBe(firstKey);
  });

  it("surfaces wait().result when a successful run streams no assistant event", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-final-only",
      stream: async function* () {
        yield { type: "status", status: "RUNNING" };
      },
      wait: async () => ({ status: "finished", result: "PINGOK" }),
      cancel: async () => {},
    });
    const ctx = makeCtx();
    const updateSpy = vi.fn();
    ctx.emit.onSessionUpdate = updateSpy;
    const adapter = new CursorSdkAdapter(ctx);
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(
      updateSpy.mock.calls.map(([, notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? notification.update.content.text
          : null,
      ),
    ).toContain("PINGOK");
  });

  it("does not duplicate wait().result after assistant text was streamed", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-stream-and-final",
      stream: async function* () {
        yield {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "PINGOK" }],
          },
        };
      },
      wait: async () => ({ status: "finished", result: "PINGOK" }),
      cancel: async () => {},
    });
    const ctx = makeCtx();
    const updateSpy = vi.fn();
    ctx.emit.onSessionUpdate = updateSpy;
    const adapter = new CursorSdkAdapter(ctx);
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(
      updateSpy.mock.calls.flatMap(([, notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? [notification.update.content.text]
          : [],
      ),
    ).toEqual(["PINGOK"]);
  });

  it("returns the SDK's per-turn token usage from the stream", async () => {
    sendSpy.mockResolvedValueOnce({
      id: "run-usage",
      stream: async function* () {
        yield {
          type: "usage",
          usage: {
            inputTokens: 120,
            outputTokens: 30,
            cacheReadTokens: 80,
            cacheWriteTokens: 4,
            totalTokens: 150,
            reasoningTokens: 7,
          },
        };
      },
      wait: async () => ({ status: "finished" }),
      cancel: async () => {},
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    const completed = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });

    expect(completed.response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 4,
      reasoningTokens: 7,
    });
  });

  it("merges provider-billed cost from getUsage into the common turn usage", async () => {
    usageSpy.mockResolvedValueOnce(EMPTY_AGENT_USAGE).mockResolvedValueOnce({
      usage: {
        inputTokens: 120,
        outputTokens: 30,
        cacheReadTokens: 80,
        cacheWriteTokens: 4,
        totalTokens: 150,
        reasoningTokens: 7,
      },
      cost: { rawCostCents: 19, chargedCents: 12.5 },
      runs: [],
    });
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    const completed = await adapter.prompt({
      sessionId: session.sessionId,
      prompt: TEXT,
    });

    expect(completed.response.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheWriteTokens: 4,
      reasoningTokens: 7,
      totalCostUsd: 0.125,
    });
  });

  it("never lets a hung billing lookup delay the agent turn", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    usageSpy.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const prompt = adapter.prompt({
        sessionId: session.sessionId,
        prompt: TEXT,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(prompt).resolves.toMatchObject({
        response: { stopReason: "end_turn" },
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("preserves live aliases, parameters, variants, and local selectability metadata", async () => {
    modelsListSpy.mockResolvedValue([
      {
        id: "default",
        displayName: "Router",
        description: "Choose automatically",
        aliases: ["auto"],
      },
      {
        id: "composer-2.5",
        displayName: "Composer 2.5",
        description: "Cursor's coding model",
        aliases: ["composer"],
        parameters: [
          {
            id: "speed",
            displayName: "Speed",
            values: [{ value: "fast", displayName: "Fast" }],
          },
        ],
        variants: [
          {
            displayName: "Balanced",
            description: "Balanced defaults",
            params: [{ id: "speed", value: "balanced" }],
            isDefault: true,
          },
        ],
      },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2.5" },
    });

    const models = (await adapter.initialize())._meta?.models ?? [];
    expect(models.find((model) => model.value === "default")).toMatchObject({
      label: "Router",
      description: "Choose automatically",
      aliases: ["auto"],
      selectable: true,
    });
    expect(
      models.find((model) => model.value === "composer-2.5"),
    ).toMatchObject({
      aliases: ["composer"],
      selectable: true,
      parameters: [
        {
          id: "speed",
          label: "Speed",
          values: [{ value: "fast", label: "Fast" }],
        },
      ],
      variants: [
        {
          label: "Balanced",
          description: "Balanced defaults",
          parameters: [{ id: "speed", value: "balanced" }],
          isDefault: true,
        },
      ],
    });
    expect(createSpy.mock.calls[0][0].model).toEqual({
      id: "composer-2.5",
      params: [{ id: "speed", value: "balanced" }],
    });
  });

  it("honors an explicit live non-selectable answer for Auto/Router", async () => {
    modelsListSpy.mockResolvedValue([
      {
        id: "default",
        displayName: "Router",
        selectable: false,
      },
      { id: "composer-2.5", displayName: "Composer 2.5" },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "default" },
    });

    expect(
      (await adapter.initialize())._meta?.models?.find(
        (model) => model.value === "default",
      ),
    ).toMatchObject({ selectable: false });
    expect(createSpy.mock.calls[0][0].model).toEqual({ id: "composer-2.5" });
  });

  it("invalidates account model metadata when the API key changes", async () => {
    modelsListSpy
      .mockResolvedValueOnce([
        { id: "composer-2.5", displayName: "Account A Composer" },
      ])
      .mockResolvedValueOnce([
        { id: "composer-2", displayName: "Account B Composer" },
      ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_account_a" },
    });
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_account_b" },
    });

    expect(modelsListSpy).toHaveBeenCalledTimes(2);
    expect((await adapter.initialize())._meta?.models?.[0]?.label).toBe(
      "Account B Composer",
    );
  });

  it("keeps each live session on the model catalog discovered for its API key", async () => {
    modelsListSpy
      .mockResolvedValueOnce([
        { id: "composer-2.5", displayName: "Account A Composer" },
      ])
      .mockResolvedValueOnce([
        { id: "composer-2", displayName: "Account B Composer" },
      ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const accountA = await adapter.newSession({
      executionId: "execution-account-a",
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_account_a",
        CURSOR_MODEL: "composer-2.5",
      },
    });
    const accountB = await adapter.newSession({
      executionId: "execution-account-b",
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_account_b",
        CURSOR_MODEL: "composer-2",
      },
    });
    sendSpy.mockClear();

    await adapter.prompt({
      sessionId: accountA.session.sessionId,
      prompt: TEXT,
    });
    await adapter.prompt({
      sessionId: accountB.session.sessionId,
      prompt: TEXT,
    });

    expect(sendSpy.mock.calls[0][1].model).toEqual({ id: "composer-2.5" });
    expect(sendSpy.mock.calls[1][1].model).toEqual({ id: "composer-2" });
  });

  it("applies live model, effort, and fast changes to the next send", async () => {
    modelsListSpy.mockResolvedValue([
      { id: "grok-4.5", displayName: "Grok 4.5" },
      {
        id: "grok-4.5-thinking-high-fast",
        displayName: "Grok 4.5 High Fast",
      },
    ]);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "grok-4.5",
        ZEROS_THINKING_EFFORT: "low",
      },
    });

    await adapter.updateConfig({
      sessionId: session.sessionId,
      env: {
        CURSOR_MODEL: "grok-4.5",
        ZEROS_THINKING_EFFORT: "high",
        ZEROS_FAST_MODE: "1",
      },
    });
    await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });

    expect(sendSpy.mock.calls[0][1].model).toEqual({
      id: "grok-4.5-thinking-high-fast",
    });
  });
});

describe("cursorAgentUsageDelta (pure)", () => {
  it("clamps cumulative counter regressions and converts charged cents to USD", () => {
    expect(
      cursorAgentUsageDelta(
        {
          usage: {
            inputTokens: 100,
            outputTokens: 20,
            cacheReadTokens: 10,
            cacheWriteTokens: 5,
            totalTokens: 120,
            reasoningTokens: 4,
          },
          cost: { rawCostCents: 8, chargedCents: 6 },
          runs: [],
        },
        {
          usage: {
            inputTokens: 140,
            outputTokens: 35,
            cacheReadTokens: 8,
            cacheWriteTokens: 9,
            totalTokens: 175,
            reasoningTokens: 7,
          },
          cost: { rawCostCents: 13, chargedCents: 9.5 },
          runs: [],
        },
      ),
    ).toEqual({
      inputTokens: 40,
      outputTokens: 15,
      cacheReadTokens: 0,
      cacheWriteTokens: 4,
      reasoningTokens: 3,
      totalCostUsd: 0.035,
    });
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
    // Rebuild resumes Cursor's provider-owned agent id, never the distinct
    // Zeros execution route used by prompt/cancel/cache dispatch.
    expect(resumeSpy.mock.calls[0][0]).toBe("agent-xyz");
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

  it("reports and uses the replacement SDK id after a stale resume falls back fresh", async () => {
    resumeSpy.mockRejectedValueOnce(
      new Error("Agent prior-agent-id not found"),
    );
    const adapter = new CursorSdkAdapter(makeCtx());
    const loaded = await adapter.loadSession({
      sessionId: "prior-agent-id",
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    expect(loaded).toMatchObject({
      resumedFresh: true,
      replacementSessionId: "agent-xyz",
    });

    resumeSpy.mockClear().mockResolvedValue(fakeAgent);
    await adapter.setMode({
      sessionId: "prior-agent-id",
      modeId: "agent",
    });
    await adapter.prompt({ sessionId: "prior-agent-id", prompt: TEXT });
    expect(resumeSpy.mock.calls[0][0]).toBe("agent-xyz");
  });

  it("routes a resumed Cursor agent through a distinct Zeros execution id", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    const loaded = await adapter.loadSession({
      executionId: "zeros-execution-1",
      providerBinding: {
        version: 1,
        providerId: "cursor",
        kind: "native",
        resumeId: "cursor-agent-previous",
      },
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });

    expect(resumeSpy).toHaveBeenCalledWith(
      "cursor-agent-previous",
      expect.any(Object),
    );
    expect(loaded.providerBinding).toEqual({
      version: 1,
      providerId: "cursor",
      kind: "native",
      resumeId: "agent-xyz",
    });
    await adapter.prompt({ sessionId: "zeros-execution-1", prompt: TEXT });
    expect(sendSpy).toHaveBeenCalled();
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

describe("CursorSdkAdapter — multi-root workspaces (@cursor/sdk 1.0.28 local.dirs)", () => {
  it("accepts native absolute paths on Windows as well as POSIX", () => {
    expect(
      parseCursorAdditionalDirs(
        '["C:\\\\work\\\\api","relative\\\\path"]',
        path.win32,
      ),
    ).toEqual(["C:\\work\\api"]);
  });

  it("carries /add-dir directories into local.dirs with cwd first", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        ZEROS_ADDITIONAL_DIRS: '["/work/api","/work/web","/tmp/proj"]',
      },
    });

    const [opts] = createSpy.mock.calls[0];
    // cwd stays the PRIMARY root (shell cwd + agent-store scoping); the extra
    // roots widen rule/skill/context loading. The duplicate cwd entry is dropped.
    expect(opts.local.cwd).toBe("/tmp/proj");
    expect(opts.local.dirs).toEqual(["/tmp/proj", "/work/api", "/work/web"]);
  });

  it("omits local.dirs entirely for a single-root chat", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test" },
    });
    expect(createSpy.mock.calls[0][0].local).not.toHaveProperty("dirs");
  });

  it("ignores a malformed or relative additional-dirs value", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());
    await adapter.newSession({
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        ZEROS_ADDITIONAL_DIRS: '["relative/path", 7, "  "]',
      },
    });
    expect(createSpy.mock.calls[0][0].local).not.toHaveProperty("dirs");

    createSpy.mockClear();
    const tolerant = new CursorSdkAdapter(makeCtx());
    await tolerant.newSession({
      cwd: "/tmp/proj",
      env: { CURSOR_API_KEY: "key_test", ZEROS_ADDITIONAL_DIRS: "not-json" },
    });
    expect(createSpy.mock.calls[0][0].local).not.toHaveProperty("dirs");
  });
});

describe("CursorSdkAdapter — model discovery never blocks session start", () => {
  it("keeps curated Grok 4.6 effort/Fast on create, send, and a mode rebuild while discovery is pending", async () => {
    let releaseCatalog = () => {};
    modelsListSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCatalog = () => resolve([]);
        }),
    );
    const expected = {
      id: "grok-4.6",
      params: [
        { id: "effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    };
    try {
      const adapter = new CursorSdkAdapter(makeCtx());
      const { session } = await adapter.newSession({
        cwd: "/tmp/proj",
        env: {
          CURSOR_API_KEY: "key_test",
          CURSOR_MODEL: "grok-4.6",
          ZEROS_THINKING_EFFORT: "xhigh",
          ZEROS_FAST_MODE: "1",
        },
      });

      expect(createSpy.mock.calls[0][0].model).toEqual(expected);
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
      expect(sendSpy.mock.calls[0][1].model).toEqual(expected);

      await adapter.setMode({ sessionId: session.sessionId, modeId: "agent" });
      await adapter.prompt({ sessionId: session.sessionId, prompt: TEXT });
      expect(resumeSpy.mock.calls[0][1].model).toEqual(expected);
      expect(sendSpy.mock.calls[1][1].model).toEqual(expected);
    } finally {
      releaseCatalog();
    }
  });

  it("keeps curated Grok 4.6 effort/Fast on resume when discovery rejects", async () => {
    modelsListSpy.mockRejectedValue(new Error("catalog unavailable"));
    const adapter = new CursorSdkAdapter(makeCtx());
    const loaded = await adapter.loadSession({
      executionId: "grok-after-restart",
      sessionId: "provider-grok-agent",
      cwd: "/tmp/proj",
      env: {
        CURSOR_API_KEY: "key_test",
        CURSOR_MODEL: "grok-4.6",
        ZEROS_THINKING_EFFORT: "xhigh",
        ZEROS_FAST_MODE: "1",
      },
    });
    const expected = {
      id: "grok-4.6",
      params: [
        { id: "effort", value: "xhigh" },
        { id: "fast", value: "true" },
      ],
    };

    expect(resumeSpy.mock.calls[0][1].model).toEqual(expected);
    await adapter.prompt({ sessionId: loaded.executionId!, prompt: TEXT });
    expect(sendSpy.mock.calls[0][1].model).toEqual(expected);
  });

  it("creates the agent immediately while a hung catalog request continues", async () => {
    let releaseCatalog = () => {};
    modelsListSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseCatalog = () => resolve([{ id: "composer-2.5" }]);
        }),
    );
    try {
      const adapter = new CursorSdkAdapter(makeCtx());
      const flight = adapter.newSession({
        cwd: "/tmp/proj",
        env: { CURSOR_API_KEY: "key_test", CURSOR_MODEL: "composer-2.5" },
      });
      await Promise.race([
        flight,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("session start waited for model catalog")),
            250,
          );
        }),
      ]);
      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy.mock.calls[0][0].model).toEqual({ id: "composer-2.5" });
    } finally {
      releaseCatalog();
    }
  });
});
