import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CURSOR_STATE_RECOVERY_HOLD_FILE } from "../../../session-paths";
import type { AgentAdapterContext } from "../../../types";
import type { PreparedBoundary } from "../../../containment/types";
import { CursorSdkAdapter } from "../adapter";

const {
  createRuntimeSpy,
  createSpy,
  disposeSpy,
  listSpy,
  modelsListSpy,
  resumeSpy,
} = vi.hoisted(() => ({
    createRuntimeSpy: vi.fn(),
    createSpy: vi.fn(),
    disposeSpy: vi.fn(),
    listSpy: vi.fn(),
    modelsListSpy: vi.fn(),
    resumeSpy: vi.fn(),
  }));

vi.mock("../host/host-client", () => {
  const module = {
    Agent: {
      create: createSpy,
      resume: resumeSpy,
      list: listSpy,
    },
    Cursor: { models: { list: modelsListSpy } },
  };
  return {
    createCursorHostRuntime: createRuntimeSpy,
    getCursorHostModule: vi.fn(() => module),
    CURSOR_HOST_EXITED_CODE: "CURSOR_HOST_EXITED",
    CURSOR_HOST_CRASH_LOOP_CODE: "CURSOR_HOST_CRASH_LOOP",
    CURSOR_HOST_CRASH_LOOP_ADVICE: "Restart Cursor",
  };
});

let root: string;
let generationRoot: string;
let previousDataDir: string | undefined;

const fakeAgent = {
  agentId: "agent-1",
  send: vi.fn(),
  close: vi.fn(),
};

function makeCtx(): AgentAdapterContext {
  return {
    projectRoot: root,
    mcpServers: [],
    sessionDirRoot: path.join(root, "sessions"),
    emit: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  };
}

function boundary(): PreparedBoundary {
  return {
    privateStateDirectory: () => {
      throw new Error("host-parity Cursor must not request private state");
    },
  } as unknown as PreparedBoundary;
}

async function recoveryMarkerExists(): Promise<boolean> {
  try {
    await access(path.join(generationRoot, CURSOR_STATE_RECOVERY_HOLD_FILE));
    return true;
  } catch {
    return false;
  }
}

beforeAll(() => {
  process.env.CURSOR_RIPGREP_PATH = "/usr/bin/rg";
});

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "zeros-cursor-startup-cleanup-"));
  generationRoot = path.join(
    root,
    "sessions",
    "session-1",
    "boundary",
    "gen-1",
  );
  previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  delete process.env.CURSOR_API_KEY;
  createSpy.mockReset().mockResolvedValue(fakeAgent);
  resumeSpy.mockReset().mockResolvedValue(fakeAgent);
  disposeSpy.mockReset().mockResolvedValue(undefined);
  listSpy.mockReset().mockResolvedValue({ items: [] });
  modelsListSpy.mockReset().mockResolvedValue([]);
  createRuntimeSpy.mockReset().mockImplementation(() => ({
    module: {
      Agent: {
        create: createSpy,
        resume: resumeSpy,
        list: listSpy,
      },
      Cursor: { models: { list: modelsListSpy } },
    },
    dispose: disposeSpy,
  }));
});

afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
  else process.env.ZEROS_DATA_DIR = previousDataDir;
  await rm(root, { recursive: true, force: true });
});

describe("CursorSdkAdapter — failed contained startup cleanup", () => {
  it("uses and retires a dedicated contained host for provider one-shots", async () => {
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.validateApiKey("candidate", {
        cwd: root,
        env: { CURSOR_API_KEY: "candidate" },
        executionBoundary: boundary(),
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      adapter.listSessions({
        cwd: root,
        env: { CURSOR_API_KEY: "candidate" },
        executionBoundary: boundary(),
      }),
    ).resolves.toEqual({ sessions: [] });

    expect(createRuntimeSpy).toHaveBeenCalledTimes(2);
    expect(modelsListSpy).toHaveBeenCalledWith({ apiKey: "candidate" });
    expect(listSpy).toHaveBeenCalledWith({ runtime: "local", cwd: root });
    expect(disposeSpy).toHaveBeenCalledTimes(2);
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("does not hide a one-shot host teardown proof failure or arm legacy recovery", async () => {
    disposeSpy.mockRejectedValueOnce(
      new Error("Cursor one-shot host stop was not proven"),
    );
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.validateApiKey("candidate", {
        cwd: root,
        env: { CURSOR_API_KEY: "candidate" },
        executionBoundary: boundary(),
      }),
    ).rejects.toThrow("Cursor one-shot host stop was not proven");
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("retains a live cleanup handle so failed teardown can be retried", async () => {
    disposeSpy
      .mockRejectedValueOnce(new Error("Cursor host stop was not proven"))
      .mockResolvedValueOnce(undefined);
    const adapter = new CursorSdkAdapter(makeCtx());
    const { session } = await adapter.newSession({
      cwd: root,
      env: { CURSOR_API_KEY: "key" },
      executionBoundary: boundary(),
    });

    await expect(adapter.disposeSession(session.sessionId)).rejects.toThrow(
      "Cursor host stop was not proven",
    );
    expect(await recoveryMarkerExists()).toBe(false);

    await expect(
      adapter.disposeSession(session.sessionId),
    ).resolves.toBeUndefined();
    expect(disposeSpy).toHaveBeenCalledTimes(2);
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("does not arm legacy recovery when the dedicated host cannot be constructed", async () => {
    createRuntimeSpy.mockImplementationOnce(() => {
      throw new Error("Cursor host construction failed");
    });
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.newSession({
        cwd: root,
        env: { CURSOR_API_KEY: "key" },
        executionBoundary: boundary(),
      }),
    ).rejects.toThrow("Cursor host construction failed");

    expect(disposeSpy).not.toHaveBeenCalled();
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("stops the dedicated host when new-session admission fails", async () => {
    createSpy.mockRejectedValueOnce(new Error("Invalid User API Key"));
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.newSession({
        cwd: root,
        env: { CURSOR_API_KEY: "invalid" },
        executionBoundary: boundary(),
      }),
    ).rejects.toThrow("Invalid User API Key");

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("stops the dedicated host when resume admission fails", async () => {
    resumeSpy.mockRejectedValueOnce(new Error("Invalid User API Key"));
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.loadSession({
        sessionId: "prior-agent-id",
        cwd: root,
        env: { CURSOR_API_KEY: "invalid" },
        executionBoundary: boundary(),
      }),
    ).rejects.toThrow("Invalid User API Key");

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(await recoveryMarkerExists()).toBe(false);
  });

  it("stops the dedicated host when a fresh resume fallback fails", async () => {
    resumeSpy.mockRejectedValueOnce(
      new Error("Agent prior-agent-id not found"),
    );
    createSpy.mockRejectedValueOnce(new Error("Invalid User API Key"));
    const adapter = new CursorSdkAdapter(makeCtx());

    await expect(
      adapter.loadSession({
        sessionId: "prior-agent-id",
        cwd: root,
        env: { CURSOR_API_KEY: "invalid" },
        executionBoundary: boundary(),
      }),
    ).rejects.toThrow("Invalid User API Key");

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(await recoveryMarkerExists()).toBe(false);
  });
});
