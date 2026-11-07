// Regression (Alpha log, 2026-11-05): a reopened Cursor chat on grok-4.7 waited
// 31 s for its first turn. The adapter confirmed the account's catalog, then
// Agent.resume validated the model against a second, serial GET /v1/models
// that took 25 s. The adapter now hands the session host the confirmed record
// for the selected model, and only while that catalog is fresh; the host and
// SDK half is pinned in host/__tests__/local-model-catalog.test.ts.

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedBoundary } from "../../../containment/types";
import type { AgentAdapterContext } from "../../../types";
import { CursorSdkAdapter } from "../adapter";

const sdk = vi.hoisted(() => ({
  create: vi.fn(), resume: vi.fn(), send: vi.fn(), models: vi.fn(), prewarm: vi.fn(), dispose: vi.fn(),
}));
vi.mock("../host/host-client", () => ({
  createCursorHostRuntime: () => ({
    module: {
      Agent: { create: sdk.create, resume: sdk.resume, list: vi.fn() },
      Cursor: { models: { list: sdk.models } },
      platform: { prewarm: sdk.prewarm },
    },
    dispose: sdk.dispose,
  }),
  getCursorHostModule: vi.fn(),
  CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED",
  CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP",
  CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor",
}));

const GROK = {
  id: "grok-4.6",
  displayName: "Grok 4.6",
  parameters: [{ id: "reasoning_effort", values: [{ value: "high" }, { value: "xhigh" }] }],
  variants: [{ displayName: "Grok", isDefault: true, params: [{ id: "reasoning_effort", value: "high" }] }],
};
const COMPOSER = { id: "composer-2.5", displayName: "Composer 2.5", aliases: ["composer"] };
const KEY = "synthetic-account-key";
let root = "";
let previousDataDir: string | undefined;

function boundary(): PreparedBoundary {
  return {
    status: { actor: "agent-code", backend: "none" },
    privateStateDirectory: () => {
      throw new Error("host-parity Cursor must not request private state");
    },
  } as unknown as PreparedBoundary;
}

function setup() {
  const context: AgentAdapterContext = {
    projectRoot: root,
    sessionDirRoot: path.join(root, "sessions"),
    mcpServers: [],
    authenticationContext: () => "local-account",
    emit: {
      onSessionUpdate() {}, onAgentStderr() {}, onAgentExit() {}, onPermissionRequest() {}, onQuestionRequest() {},
    },
  };
  return new CursorSdkAdapter(context);
}

function session(executionId: string, model: string, sessionId?: string) {
  return {
    cwd: root,
    executionId,
    ...(sessionId ? { sessionId } : {}),
    env: { CURSOR_API_KEY: KEY, CURSOR_MODEL: model },
    executionBoundary: boundary(),
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-native-catalog-"));
  previousDataDir = process.env.ZEROS_DATA_DIR;
  vi.stubEnv("ZEROS_DATA_DIR", path.join(root, "engine"));
  vi.stubEnv("CURSOR_API_KEY", "");
  vi.stubEnv("CURSOR_RIPGREP_PATH", "/usr/bin/rg");
  sdk.create.mockReset().mockResolvedValue({ agentId: "new-agent", close() {}, send: sdk.send });
  sdk.resume.mockReset().mockResolvedValue({ agentId: "saved-agent", close() {}, send: sdk.send });
  sdk.send.mockReset().mockImplementation(async () => ({
    id: "run-1",
    stream: async function* () {},
    wait: async () => ({ status: "finished" }),
    cancel: async () => {},
  }));
  sdk.models.mockReset().mockResolvedValue([COMPOSER, GROK]);
  sdk.prewarm.mockReset().mockResolvedValue({ prewarmed: true });
  sdk.dispose.mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (previousDataDir !== undefined) process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("Cursor model validation handoff", () => {
  it("resumes a registry model with the record its awaited discovery confirmed", async () => {
    const adapter = setup();
    try {
      await adapter.loadSession(session("reopened", "grok-4.6", "saved-agent"));
      expect(sdk.models).toHaveBeenCalledTimes(1);
      expect(sdk.resume).toHaveBeenCalledExactlyOnceWith(
        "saved-agent",
        expect.objectContaining({ model: expect.objectContaining({ id: "grok-4.6" }) }),
        { localModelCatalog: [GROK] },
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("reuses a fresh catalog for the next chat and matches the SDK's alias lookup", async () => {
    const adapter = setup();
    try {
      await adapter.loadSession(session("first", "grok-4.6", "saved-agent"));
      await adapter.newSession(session("second", "composer"));
      expect(sdk.models).toHaveBeenCalledTimes(1);
      expect(sdk.create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ model: expect.objectContaining({ id: "composer-2.5" }) }),
        { localModelCatalog: [COMPOSER] },
      );
    } finally {
      await adapter.dispose();
    }
  });

  // Regression (Mac, 2026-11-07): the first send of every new Cursor chat read
  // GET /v1/models again for 1.6 s; send() validates its model too.
  it("sends with the record for the turn's model while the catalog is fresh", async () => {
    const adapter = setup();
    try {
      const { session: created } = await adapter.newSession(session("chat", "grok-4.6"));
      await adapter.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
      expect(sdk.send).toHaveBeenCalledExactlyOnceWith(
        { text: "hi" },
        expect.objectContaining({ model: expect.objectContaining({ id: "grok-4.6" }) }),
        { localModelCatalog: [GROK] },
      );
    } finally {
      await adapter.dispose();
    }
  });

  it("leaves a send's validation to Cursor until a replacement key's catalog is active", async () => {
    const adapter = setup();
    try {
      const { session: created } = await adapter.newSession(session("chat", "grok-4.6"));
      const states = adapter as unknown as { activateModelState(key: string): Promise<unknown> };
      const activate = states.activateModelState.bind(adapter);
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(states, "activateModelState").mockImplementationOnce(async (key) => {
        await held;
        return activate(key);
      });
      const replaced = adapter.capabilityPorts.runtimeConfiguration.updateCredentials({
        sessionId: created.sessionId,
        keys: ["CURSOR_API_KEY"],
        env: { CURSOR_API_KEY: "replacement-account-key" },
        authenticationContext: "local-account",
      });
      await adapter.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "hi" }] });
      expect(sdk.resume).toHaveBeenCalledWith(
        "new-agent",
        expect.objectContaining({ apiKey: "replacement-account-key" }),
      );
      expect(sdk.send).toHaveBeenCalledTimes(1);
      expect(sdk.send.mock.calls[0]).toHaveLength(2);
      release();
      await replaced;
    } finally {
      await adapter.dispose();
    }
  });

  it("leaves validation to Cursor while the catalog is still unconfirmed", async () => {
    sdk.models.mockReturnValue(new Promise(() => {}));
    const adapter = setup();
    try {
      await adapter.newSession(session("cold", "composer-2.5"));
      expect(sdk.create).toHaveBeenCalledTimes(1);
      expect(sdk.create.mock.calls[0]).toHaveLength(1);
    } finally {
      await adapter.dispose();
    }
  });
});
