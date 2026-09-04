// gateway newSession/loadSession — NATIVE system-instruction routing. An
// adapter declaring `nativeSystemInstruction` (Codex) receives Zeros'
// first-turn orientation as the UNWRAPPED `systemInstruction` opt at session
// create/resume — it delivers it on the protocol's own instruction field
// (thread/start|resume.developerInstructions) — and the gateway pre-marks the
// session instructed so the first prompt is NOT also prepended with the
// in-band <system_instruction> block. Adapters without the flag keep the
// legacy mechanism A untouched.

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGateway } from "../gateway";
import type {
  AgentAdapter,
  AgentFilesystemTerritory,
  ContentBlock,
  LoadSessionResponse,
  PromptResponse,
} from "../types";
import type { ProviderBinding } from "@zeros/protocol/identities";
import type { BoundaryRequest, ExecutionBoundary } from "../containment/types";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

function makeGateway(
  executionBoundary: ExecutionBoundary = testExecutionBoundary(),
) {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-test",
    executionBoundary,
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
}

type GwInternals = {
  adapters: Map<string, AgentAdapter>;
  sessionsInstructed: Set<string>;
  executionToInstructionCtx: Map<
    string,
    {
      additionalDirectories: string[];
      designContextDirectories?: string[];
    }
  >;
  prepareCodeAgentTerritory(
    ...args: unknown[]
  ): Promise<AgentFilesystemTerritory | undefined>;
  resolveSessionMcp(...args: unknown[]): Promise<unknown[]>;
};

interface FakeCalls {
  newSessionOpts: Array<Record<string, unknown>>;
  loadSessionOpts: Array<Record<string, unknown>>;
  updateConfigOpts: Array<Record<string, unknown>>;
  prompts: ContentBlock[][];
}

/** A fake adapter that records session-create opts + every prompt array. */
function fakeAdapter(opts: {
  agentId: string;
  native: boolean;
  sessionId: string;
  resumedFresh?: boolean;
  calls: FakeCalls;
}): AgentAdapter {
  return {
    agentId: opts.agentId,
    ...(opts.native ? { nativeSystemInstruction: true } : {}),
    newSession: async (o: Record<string, unknown>) => {
      opts.calls.newSessionOpts.push(o);
      return {
        session: {
          executionId: o.executionId,
          sessionId: o.executionId,
        },
        initialize: {},
      };
    },
    loadSession: async (
      o: Record<string, unknown>,
    ): Promise<LoadSessionResponse> => {
      opts.calls.loadSessionOpts.push(o);
      return {
        executionId: o.executionId as string,
        resumedFresh: opts.resumedFresh ?? false,
      };
    },
    updateConfig: async (o: Record<string, unknown>) => {
      opts.calls.updateConfigOpts.push(o);
    },
    prompt: async ({ prompt }: { prompt: ContentBlock[] }) => {
      opts.calls.prompts.push(prompt);
      return { response: {} as PromptResponse };
    },
    dispose: async () => {},
  } as unknown as AgentAdapter;
}

function calls(): FakeCalls {
  return {
    newSessionOpts: [],
    loadSessionOpts: [],
    updateConfigOpts: [],
    prompts: [],
  };
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

const CWD = os.tmpdir();

describe("gateway native system-instruction routing", () => {
  let previousUserSettingsDir: string | undefined;
  let userSettingsDir: string;

  beforeEach(() => {
    previousUserSettingsDir = process.env.ZEROS_USER_SETTINGS_DIR;
    userSettingsDir = mkdtempSync(
      path.join(os.tmpdir(), "zeros-native-instructions-user-"),
    );
    process.env.ZEROS_USER_SETTINGS_DIR = userSettingsDir;
  });

  afterEach(() => {
    rmSync(userSettingsDir, { recursive: true, force: true });
    if (previousUserSettingsDir === undefined) {
      delete process.env.ZEROS_USER_SETTINGS_DIR;
    } else {
      process.env.ZEROS_USER_SETTINGS_DIR = previousUserSettingsDir;
    }
  });

  it("newSession passes the UNWRAPPED body to a native adapter and skips the in-band prepend", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-native",
        calls: c,
      }),
    );

    const session = await gw.newSession("codex", {
      cwd: CWD,
      env: { ZEROS_TARGET_BRANCH: "origin/dev" },
    });

    // The adapter got the orientation, unwrapped, on the native channel opt.
    expect(c.newSessionOpts).toHaveLength(1);
    const instr = c.newSessionOpts[0]!.systemInstruction as string;
    expect(instr).toContain("working inside Zeros");
    expect(instr).toContain(CWD);
    expect(instr).toContain("origin/dev");
    expect(instr).not.toContain("<system_instruction>");

    // First prompt: NO in-band block — the native channel already carried it.
    await gw.prompt("codex", session.executionId, [text("fix the login bug")]);
    expect(c.prompts[0]).toEqual([text("fix the login bug")]);
  });

  it("newSession leaves a non-native adapter on mechanism A (in-band, first prompt only)", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "cursor",
      fakeAdapter({
        agentId: "cursor",
        native: false,
        sessionId: "s-inband",
        calls: c,
      }),
    );

    const session = await gw.newSession("cursor", { cwd: CWD });

    expect(c.newSessionOpts[0]!.systemInstruction).toBeUndefined();

    await gw.prompt("cursor", session.executionId, [text("hello")]);
    await gw.prompt("cursor", session.executionId, [text("again")]);

    // First prompt: block prepended ahead of the user's text.
    expect(c.prompts[0]).toHaveLength(2);
    expect((c.prompts[0]![0] as { text: string }).text).toContain(
      "<system_instruction>",
    );
    expect(c.prompts[0]![1]).toEqual(text("hello"));
    // Second prompt: one-shot spent.
    expect(c.prompts[1]).toEqual([text("again")]);
  });

  it("keeps Design context in native Code instructions, not host boundary policy", async () => {
    const requests: BoundaryRequest[] = [];
    const testBoundary = testExecutionBoundary({
      onPrepare: (request) => requests.push(request),
    });
    const gw = makeGateway({ ...testBoundary, backend: "none" });
    const c = calls();
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: `${CWD}/Zeros Design`,
      protectedDesignDirectories: [`${CWD}/Zeros Design`],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [`${CWD}/Zeros Design`],
      },
    };
    const internals = gw as unknown as GwInternals;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "native-context",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => territory;

    await gw.newSession("codex", { cwd: CWD });

    expect(c.newSessionOpts[0]!.systemInstruction).toContain(
      `${CWD}/Zeros Design`,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actor: "agent-code",
      backendHint: "none",
    });
    expect(requests[0]).not.toHaveProperty("territory");
    expect(requests[0]).not.toHaveProperty("protectedCodeDirectories");
    expect(requests[0]).not.toHaveProperty("protectedWorkspaceDirectories");
    expect(requests[0]).not.toHaveProperty("gitIntegrationRoots");
    await gw.dispose();
  });

  it("reasserts a changed Design territory to an already-live native Code session", async () => {
    const gw = makeGateway({ ...testExecutionBoundary(), backend: "none" });
    const c = calls();
    const firstDesign = `${CWD}/Zeros Design`;
    const nextDesign = `${CWD}/Product Design`;
    const initialTerritory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: firstDesign,
      protectedDesignDirectories: [firstDesign],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [firstDesign],
      },
    };
    const nextTerritory: AgentFilesystemTerritory = {
      ...initialTerritory,
      designDirectory: nextDesign,
      protectedDesignDirectories: [nextDesign],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [nextDesign],
      },
    };
    const internals = gw as unknown as GwInternals;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "native-context-refresh",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => initialTerritory;

    const session = await gw.newSession("codex", {
      cwd: CWD,
      workspaceId: "workspace-1",
    });
    expect(c.newSessionOpts[0]!.systemInstruction).toContain(firstDesign);

    expect(
      gw.refreshNativeCodeTerritoryContext(
        "workspace-1",
        CWD,
        nextTerritory,
      ),
    ).toBe(1);

    await gw.prompt("codex", session.executionId, [text("continue")]);
    await gw.prompt("codex", session.executionId, [text("again")]);

    const refresh = (c.prompts[0]![0] as { text: string }).text;
    expect(refresh).toContain("<system_instruction>");
    expect(refresh).toContain(nextDesign);
    expect(refresh).not.toContain(firstDesign);
    expect(c.prompts[0]![1]).toEqual(text("continue"));
    expect(c.prompts[1]).toEqual([text("again")]);

    await gw.dispose();
  });

  it("admits a persistent Design session with only its scoped MCP and ZSR actor", async () => {
    const requests: BoundaryRequest[] = [];
    const gw = makeGateway(
      testExecutionBoundary({ onPrepare: (request) => requests.push(request) }),
    );
    const c = calls();
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: `${CWD}/Zeros Design`,
      protectedDesignDirectories: [`${CWD}/Zeros Design`],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [`${CWD}/Zeros Design`, `${CWD}/.git`],
      },
    };
    const internals = gw as unknown as GwInternals;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "design-session",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => territory;
    const resolveMcp = vi.fn(async () => [
      { name: "user-server", transport: "stdio", command: "unsafe" },
    ]);
    internals.resolveSessionMcp = resolveMcp;

    const session = await gw.newDesignSession(
      "codex",
      {
        actor: "design-agent",
        agentRunId: "design-run-1",
        env: {
          ZEROS_DESIGN_AGENT_CAPABILITY: `Bearer ${"a".repeat(64)}`,
        },
        mcpServers: [
          {
            name: "design-draft",
            transport: "http",
            url: "http://127.0.0.1:43123/mcp",
            headersFromEnv: {
              Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY",
            },
          },
        ],
        trustedLocalPorts: [43123],
      },
      {
        cwd: CWD,
        env: {
          ZEROS_DESIGN_AGENT_CAPABILITY: "untrusted-override",
          ZEROS_ADDITIONAL_DIRS: '["/work/reference"]',
        },
      },
    );

    expect(resolveMcp).not.toHaveBeenCalled();
    expect(c.newSessionOpts[0]).toMatchObject({
      env: {
        ZEROS_DESIGN_AGENT_CAPABILITY: `Bearer ${"a".repeat(64)}`,
        ZEROS_ADDITIONAL_DIRS: '["/work/reference"]',
      },
      mcpServers: [
        {
          name: "design-draft",
          transport: "http",
          url: "http://127.0.0.1:43123/mcp",
        },
      ],
    });
    expect(c.newSessionOpts[0]!.territory).toBeUndefined();
    const instruction = c.newSessionOpts[0]!.systemInstruction as string;
    expect(instruction).toContain("Design agent");
    expect(instruction).toContain("design_transaction_apply");
    expect(instruction).not.toContain("You are a coding agent");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      actor: "design-agent",
      allowedLocalPorts: [43123],
      trustedLocalPorts: [43123],
    });
    expect(session.executionId).toBeTruthy();
    expect(gw.sessionActor(session.executionId)).toBe("design-agent");
    expect(
      gw.workspaceSessionIds("workspace-1", CWD, {
        actor: "agent-code",
      }),
    ).toEqual([]);
    expect(
      gw.workspaceSessionIds("workspace-1", CWD, {
        actor: "design-agent",
      }),
    ).toEqual([session.executionId]);
    expect(
      gw.workspaceTerritoryChanged("workspace-1", CWD, undefined, {
        actor: "agent-code",
      }),
    ).toBe(false);
    expect(
      gw.workspaceTerritoryChanged("workspace-1", CWD, undefined, {
        actor: "design-agent",
      }),
    ).toBe(true);
  });

  it("preserves the normal provider surface while ZSR subtracts Design authority", async () => {
    const gw = makeGateway();
    const c = calls();
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: `${CWD}/Zeros Design`,
      protectedDesignDirectories: [`${CWD}/Zeros Design`],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [`${CWD}/Zeros Design`, `${CWD}/.git`],
      },
    };
    const internals = gw as unknown as GwInternals;
    const resolveMcp = vi.fn(async () => [
      { name: "unsafe-local", transport: "stdio", command: "helper" },
    ]);
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-contained",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => territory;
    internals.resolveSessionMcp = resolveMcp;

    const session = await gw.newSession("codex", {
      cwd: CWD,
      env: {
        ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
        CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
        CLAUDE_CODE_MANAGED_SETTINGS_PATH: "/work/managed.json",
        CLAUDE_CODE_PLUGIN_CACHE_DIR: "/work/plugins",
        CLAUDE_CODE_SANDBOXED: "1",
        CLAUDE_TMPDIR: "/work/tmp",
        PATH: "/work/bin",
        NODE_OPTIONS: "--require=/work/preload.cjs",
        LD_PRELOAD: "/work/inject.so",
        ZEROS_FAST_MODE: "1",
      },
    });

    const spawnEnv = c.newSessionOpts[0]!.env as Record<string, string>;
    expect(spawnEnv).toMatchObject({
      ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
      CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
      CLAUDE_CODE_MANAGED_SETTINGS_PATH: "/work/managed.json",
      CLAUDE_CODE_PLUGIN_CACHE_DIR: "/work/plugins",
      CLAUDE_CODE_SANDBOXED: "1",
      CLAUDE_TMPDIR: "/work/tmp",
      PATH: "/work/bin",
      NODE_OPTIONS: "--require=/work/preload.cjs",
      LD_PRELOAD: "/work/inject.so",
      ZEROS_FAST_MODE: "1",
    });
    expect(c.newSessionOpts[0]!.systemInstruction).toContain("/work/context");
    // Local MCP starts below the provider process root and therefore inherits
    // the same outer ZSR boundary instead of being stripped for Design work.
    expect(resolveMcp).toHaveBeenCalledOnce();
    expect(c.newSessionOpts[0]!.mcpServers).toEqual([
      { name: "unsafe-local", transport: "stdio", command: "helper" },
    ]);
    expect(c.newSessionOpts[0]!.executionBoundary).toBeDefined();
    expect(session.boundary).toMatchObject({
      state: "ready",
      backend: "zeros-srt",
      designProtection: {
        required: true,
        enforced: true,
        protectedDirectoryCount: 1,
      },
      parity: { level: "full", restrictions: [] },
    });
    expect(session.boundary?.designProtection.territoryGeneration).toEqual(
      expect.any(String),
    );

    await gw.updateConfig("codex", session.executionId, {
      ZEROS_ADDITIONAL_DIRS: '["/work/other"]',
      CLAUDE_CODE_PROCESS_WRAPPER: "/work/other-wrapper",
      CLAUDE_ENV_FILE: "/work/.env",
      PATH: "/work/other-bin",
      ZEROS_FAST_MODE: "1",
    });
    expect(c.updateConfigOpts).toEqual([
      {
        sessionId: session.executionId,
        env: {
          ZEROS_ADDITIONAL_DIRS: '["/work/other"]',
          CLAUDE_CODE_PROCESS_WRAPPER: "/work/other-wrapper",
          CLAUDE_ENV_FILE: "/work/.env",
          PATH: "/work/other-bin",
          ZEROS_FAST_MODE: "1",
        },
      },
    ]);
  });

  it("preserves ordinary code-only additional roots and runtime env compatibility", async () => {
    const gw = makeGateway();
    const c = calls();
    const internals = gw as unknown as GwInternals;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-code-only",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => undefined;

    await gw.newSession("codex", {
      cwd: CWD,
      env: {
        ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
        ZEROS_ISOLATION_CONTEXT_DIRS: '["/work/spoofed-context"]',
        PATH: "/work/bin",
        CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
      },
    });

    expect(c.newSessionOpts[0]!.env).toMatchObject({
      ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
      PATH: "/work/bin",
      CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
    });
    expect(c.newSessionOpts[0]!.env).not.toHaveProperty(
      "ZEROS_ISOLATION_CONTEXT_DIRS",
    );
  });

  it("drops the retired isolation-context courier across live config updates", async () => {
    const gw = makeGateway();
    const c = calls();
    const internals = gw as unknown as GwInternals;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-context-update",
        calls: c,
      }),
    );
    internals.prepareCodeAgentTerritory = async () => undefined;
    const session = await gw.newSession("codex", { cwd: CWD });

    await gw.updateConfig("codex", session.executionId, {
      ZEROS_ADDITIONAL_DIRS: JSON.stringify(["/work/user-root"]),
      ZEROS_ISOLATION_CONTEXT_DIRS: JSON.stringify(["/work/spoofed-context"]),
      ZEROS_FAST_MODE: "1",
    });

    expect(c.updateConfigOpts.at(-1)).toEqual({
      sessionId: session.executionId,
      env: {
        ZEROS_ADDITIONAL_DIRS: JSON.stringify(["/work/user-root"]),
        ZEROS_FAST_MODE: "1",
      },
    });
  });

  it("applies the same territory, environment, instruction, and MCP admission to native forks", async () => {
    const gw = makeGateway();
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: `${CWD}/Zeros Design`,
      protectedDesignDirectories: [`${CWD}/Zeros Design`],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [`${CWD}/Zeros Design`, `${CWD}/.git`],
      },
    };
    const forkCalls: Array<Record<string, unknown>> = [];
    const internals = gw as unknown as GwInternals;
    const prepare = vi.fn(async () => territory);
    const resolveMcp = vi.fn(async () => [
      { name: "unsafe-local", transport: "stdio", command: "helper" },
    ]);
    internals.prepareCodeAgentTerritory = prepare;
    internals.resolveSessionMcp = resolveMcp;
    internals.adapters.set("codex", {
      agentId: "codex",
      nativeSystemInstruction: true,
      forkProviderBinding: async (opts: Record<string, unknown>) => {
        forkCalls.push(opts);
        return {
          providerBinding: {
            version: 1,
            providerId: "codex",
            kind: "native",
            resumeId: "forked-thread",
          },
        };
      },
    } as unknown as AgentAdapter);
    const source: ProviderBinding = {
      version: 1,
      providerId: "codex",
      kind: "native",
      resumeId: "source-thread",
    };

    await expect(
      gw.forkProviderBinding("codex", source, {
        cwd: CWD,
        env: {
          ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
          CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
          NODE_OPTIONS: "--require=/work/preload.cjs",
          ZEROS_FAST_MODE: "1",
        },
      }),
    ).resolves.toMatchObject({ resumeId: "forked-thread" });

    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "codex" }),
      CWD,
      undefined,
      undefined,
      "forkSession",
      { cliBinary: undefined },
    );
    expect(resolveMcp).toHaveBeenCalledOnce();
    expect(forkCalls).toHaveLength(1);
    expect(forkCalls[0]).toMatchObject({
      providerBinding: source,
      cwd: CWD,
      territory,
      mcpServers: [
        { name: "unsafe-local", transport: "stdio", command: "helper" },
      ],
      env: {
        ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
        CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
        NODE_OPTIONS: "--require=/work/preload.cjs",
        ZEROS_FAST_MODE: "1",
        ZEROS_WORKTREE_PATH: CWD,
      },
    });
    expect(forkCalls[0]!.executionBoundary).toBeDefined();
    expect(forkCalls[0]!.systemInstruction).toContain("/work/context");
    expect(forkCalls[0]!.systemInstruction).toContain(`${CWD}/Zeros Design`);
  });

  it("loadSession passes the body to a native adapter on TRUE resume, no in-band re-send", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-resume",
        resumedFresh: false,
        calls: c,
      }),
    );

    const loaded = await gw.loadSession("codex", "s-resume", { cwd: CWD });

    const instr = c.loadSessionOpts[0]!.systemInstruction as string;
    expect(instr).toContain("working inside Zeros");
    expect(instr).not.toContain("<system_instruction>");

    await gw.prompt("codex", loaded.executionId!, [text("continue")]);
    expect(c.prompts[0]).toEqual([text("continue")]);
  });

  it("keeps MCP inside the execution boundary for a Design-aware resumed session", async () => {
    const requests: BoundaryRequest[] = [];
    const gw = makeGateway(
      testExecutionBoundary({ onPrepare: (request) => requests.push(request) }),
    );
    const c = calls();
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: CWD,
      designDirectory: `${CWD}/Zeros Design`,
      protectedDesignDirectories: [`${CWD}/Zeros Design`],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [`${CWD}/Zeros Design`, `${CWD}/.git`],
      },
    };
    const internals = gw as unknown as GwInternals;
    const resolveMcp = vi.fn(async () => [
      { name: "unsafe-local", transport: "stdio", command: "helper" },
    ]);
    internals.prepareCodeAgentTerritory = async () => territory;
    internals.resolveSessionMcp = resolveMcp;
    internals.adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-contained-resume",
        resumedFresh: false,
        calls: c,
      }),
    );

    const loaded = await gw.loadSession("codex", "s-contained-resume", {
      cwd: CWD,
    });

    expect(resolveMcp).toHaveBeenCalledOnce();
    expect(c.loadSessionOpts[0]!.mcpServers).toEqual([
      { name: "unsafe-local", transport: "stdio", command: "helper" },
    ]);
    expect(c.loadSessionOpts[0]!.executionBoundary).toBeDefined();
    // A live resume replenishes a warm spare in the background; only the
    // session's own admission is under test here.
    const sessionRequests = requests.filter(
      (request) => !request.executionId.startsWith("warm-"),
    );
    expect(sessionRequests).toHaveLength(1);
    // The boundary request is resume-agnostic: containment never consumes the
    // provider resume id, and omitting it lets resumed sessions adopt warm
    // pre-admitted boundaries of the same shape.
    expect(sessionRequests[0]).not.toHaveProperty("providerResumeId");
    expect(loaded.boundary).toMatchObject({
      state: "ready",
      backend: "zeros-srt",
      designProtection: { required: true, enforced: true },
      parity: { level: "full", restrictions: [] },
    });
    expect(loaded.boundary?.designProtection.territoryGeneration).toEqual(
      expect.any(String),
    );
  });

  it("loadSession DEGRADED resume on a native adapter stays native — never re-injects in-band", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-fresh",
        resumedFresh: true, // stale rollout → adapter auto-started a fresh thread
        calls: c,
      }),
    );

    const loaded = await gw.loadSession("codex", "s-fresh", { cwd: CWD });

    // The adapter's fresh thread/start fallback carried developerInstructions
    // (it received systemInstruction), so the session stays pre-marked.
    expect(c.loadSessionOpts[0]!.systemInstruction).toBeDefined();
    expect(
      (gw as unknown as GwInternals).sessionsInstructed.has(
        loaded.executionId!,
      ),
    ).toBe(true);

    await gw.prompt("codex", loaded.executionId!, [text("keep going")]);
    expect(c.prompts[0]).toEqual([text("keep going")]);
  });

  it("loadSession DEGRADED resume on a NON-native adapter still re-arms the in-band one-shot", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "cursor",
      fakeAdapter({
        agentId: "cursor",
        native: false,
        sessionId: "s-fresh-inband",
        resumedFresh: true,
        calls: c,
      }),
    );

    const loaded = await gw.loadSession("cursor", "s-fresh-inband", {
      cwd: CWD,
    });
    await gw.prompt("cursor", loaded.executionId!, [text("hello")]);

    expect(c.prompts[0]).toHaveLength(2);
    expect((c.prompts[0]![0] as { text: string }).text).toContain(
      "<system_instruction>",
    );
  });
});
