// gateway newSession/loadSession — NATIVE system-instruction routing. An
// adapter declaring `nativeSystemInstruction` (Codex) receives Zeros'
// first-turn orientation as the UNWRAPPED `systemInstruction` opt at session
// create/resume — it delivers it on the protocol's own instruction field
// (thread/start|resume.developerInstructions) — and the gateway pre-marks the
// session instructed so the first prompt is NOT also prepended with the
// in-band <system_instruction> block. Adapters without the flag keep the
// legacy mechanism A untouched.

import os from "node:os";

import { describe, expect, it, vi } from "vitest";

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
        PATH: "/work/bin",
        CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
      },
    });

    expect(c.newSessionOpts[0]!.env).toMatchObject({
      ZEROS_ADDITIONAL_DIRS: '["/work/context"]',
      PATH: "/work/bin",
      CLAUDE_CODE_PROCESS_WRAPPER: "/work/wrapper",
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

  it("keeps MCP inside ZSR for a Design-contained resumed session", async () => {
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
