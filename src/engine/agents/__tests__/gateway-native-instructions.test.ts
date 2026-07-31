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

const workspaceRows = vi.hoisted(
  () =>
    new Map<
      string,
      { kind: "code" | "design"; path: string; repoRoot: string }
    >(),
);

vi.mock("../../git/state", () => ({
  getWorkspaceById: (workspaceId: string) =>
    workspaceRows.get(workspaceId) ?? null,
}));

vi.mock("../../git/target-branch", () => ({
  resolveWorkspaceTargetRef: async () => null,
}));

import { AgentGateway } from "../gateway";
import type {
  AgentAdapter,
  ContentBlock,
  LoadSessionResponse,
  PromptResponse,
} from "../types";

function makeGateway() {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-test",
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
};

interface FakeCalls {
  newSessionOpts: Array<Record<string, unknown>>;
  loadSessionOpts: Array<Record<string, unknown>>;
  prompts: ContentBlock[][];
}

/** A fake adapter that records session-create opts + every prompt array. */
function fakeAdapter(opts: {
  agentId: string;
  native: boolean;
  sessionId: string;
  resumedFresh?: boolean;
  loadedSessionId?: string;
  calls: FakeCalls;
}): AgentAdapter {
  return {
    agentId: opts.agentId,
    ...(opts.native ? { nativeSystemInstruction: true } : {}),
    newSession: async (o: Record<string, unknown>) => {
      opts.calls.newSessionOpts.push(o);
      return { session: { sessionId: opts.sessionId }, initialize: {} };
    },
    loadSession: async (
      o: Record<string, unknown>,
    ): Promise<LoadSessionResponse> => {
      opts.calls.loadSessionOpts.push(o);
      return {
        ...(opts.loadedSessionId ? { sessionId: opts.loadedSessionId } : {}),
        resumedFresh: opts.resumedFresh ?? false,
      } as LoadSessionResponse;
    },
    prompt: async ({ prompt }: { prompt: ContentBlock[] }) => {
      opts.calls.prompts.push(prompt);
      return { response: {} as PromptResponse };
    },
  } as unknown as AgentAdapter;
}

function calls(): FakeCalls {
  return { newSessionOpts: [], loadSessionOpts: [], prompts: [] };
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

const CWD = os.tmpdir();

describe("gateway native system-instruction routing", () => {
  it("lets confirmed workspace kind override spoofed or stale chat mode state", async () => {
    workspaceRows.set("ws-code", {
      kind: "code",
      path: CWD,
      repoRoot: CWD,
    });
    workspaceRows.set("ws-design", {
      kind: "design",
      path: CWD,
      repoRoot: CWD,
    });

    const codeGateway = makeGateway();
    const codeCalls = calls();
    (codeGateway as unknown as GwInternals).adapters.set(
      "claude",
      fakeAdapter({
        agentId: "claude",
        native: false,
        sessionId: "s-code-authoritative",
        calls: codeCalls,
      }),
    );
    await codeGateway.newSession("claude", {
      cwd: CWD,
      workspaceId: "ws-code",
      env: {
        ZEROS_CHAT_MODE: "design",
        CLAUDE_DISALLOWED_TOOLS: "Bash(rm *)",
      },
    });
    const codeEnv = codeCalls.newSessionOpts[0]!.env as Record<string, string>;
    expect(codeEnv.ZEROS_CHAT_MODE).toBeUndefined();
    expect(codeEnv.CLAUDE_DISALLOWED_TOOLS).toBe("Bash(rm *)");
    await codeGateway.prompt("claude", "s-code-authoritative", [text("go")]);
    expect((codeCalls.prompts[0]![0] as { text: string }).text).not.toContain(
      "Zeros Design/",
    );

    const designGateway = makeGateway();
    const designCalls = calls();
    (designGateway as unknown as GwInternals).adapters.set(
      "claude",
      fakeAdapter({
        agentId: "claude",
        native: false,
        sessionId: "s-design-authoritative",
        calls: designCalls,
      }),
    );
    await designGateway.newSession("claude", {
      cwd: CWD,
      workspaceId: "ws-design",
      env: { ZEROS_CHAT_MODE: "code" },
    });
    const designEnv = designCalls.newSessionOpts[0]!.env as Record<
      string,
      string
    >;
    expect(designEnv.ZEROS_CHAT_MODE).toBe("design");
    expect(designEnv.CLAUDE_DISALLOWED_TOOLS).toContain("Edit(/*)");
    await designGateway.prompt("claude", "s-design-authoritative", [
      text("go"),
    ]);
    expect(
      (designCalls.prompts[0]![0] as { text: string }).text,
    ).toContain("Zeros Design/");

    workspaceRows.clear();
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

    await gw.newSession("codex", {
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
    await gw.prompt("codex", "s-native", [text("fix the login bug")]);
    expect(c.prompts[0]).toEqual([text("fix the login bug")]);
  });

  it("adds the design contract through the same native instruction channel", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "s-design",
        calls: c,
      }),
    );

    await gw.newSession("codex", {
      cwd: CWD,
      env: { ZEROS_CHAT_MODE: "design" },
    });

    const instruction = c.newSessionOpts[0]!.systemInstruction as string;
    expect(instruction).toContain("Zeros Design/");
    expect(instruction).toContain("zeros-design");
    expect(instruction).toContain("lint_design");
    expect(
      (c.newSessionOpts[0]!.env as Record<string, string>)
        .CLAUDE_DISALLOWED_TOOLS,
    ).toBeUndefined();
  });

  it("adds Claude's design root edit guard without changing other agents", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "claude",
      fakeAdapter({
        agentId: "claude",
        native: false,
        sessionId: "s-design-claude",
        calls: c,
      }),
    );

    await gw.newSession("claude", {
      cwd: CWD,
      env: { ZEROS_CHAT_MODE: "design" },
    });

    expect(
      (c.newSessionOpts[0]!.env as Record<string, string>)
        .CLAUDE_DISALLOWED_TOOLS,
    ).toContain("Edit(/*)");
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

    await gw.newSession("cursor", { cwd: CWD });

    expect(c.newSessionOpts[0]!.systemInstruction).toBeUndefined();

    await gw.prompt("cursor", "s-inband", [text("hello")]);
    await gw.prompt("cursor", "s-inband", [text("again")]);

    // First prompt: block prepended ahead of the user's text.
    expect(c.prompts[0]).toHaveLength(2);
    expect((c.prompts[0]![0] as { text: string }).text).toContain(
      "<system_instruction>",
    );
    expect(c.prompts[0]![1]).toEqual(text("hello"));
    // Second prompt: one-shot spent.
    expect(c.prompts[1]).toEqual([text("again")]);
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

    await gw.loadSession("codex", "s-resume", { cwd: CWD });

    const instr = c.loadSessionOpts[0]!.systemInstruction as string;
    expect(instr).toContain("working inside Zeros");
    expect(instr).not.toContain("<system_instruction>");

    await gw.prompt("codex", "s-resume", [text("continue")]);
    expect(c.prompts[0]).toEqual([text("continue")]);
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

    await gw.loadSession("codex", "s-fresh", { cwd: CWD });

    // The adapter's fresh thread/start fallback carried developerInstructions
    // (it received systemInstruction), so the session stays pre-marked.
    expect(c.loadSessionOpts[0]!.systemInstruction).toBeDefined();
    expect(
      (gw as unknown as GwInternals).sessionsInstructed.has("s-fresh"),
    ).toBe(true);

    await gw.prompt("codex", "s-fresh", [text("keep going")]);
    expect(c.prompts[0]).toEqual([text("keep going")]);
  });

  it("rekeys gateway routing when a degraded resume returns a replacement session id", async () => {
    const gw = makeGateway();
    const c = calls();
    (gw as unknown as GwInternals).adapters.set(
      "codex",
      fakeAdapter({
        agentId: "codex",
        native: true,
        sessionId: "legacy-local-id",
        loadedSessionId: "thread-replacement",
        resumedFresh: true,
        calls: c,
      }),
    );

    const response = await gw.loadSession("codex", "legacy-local-id", {
      cwd: CWD,
    });

    expect(response.sessionId).toBe("thread-replacement");
    expect(
      (gw as unknown as GwInternals).sessionsInstructed.has(
        "thread-replacement",
      ),
    ).toBe(true);
    expect(
      (gw as unknown as GwInternals).sessionsInstructed.has("legacy-local-id"),
    ).toBe(false);
    await gw.prompt("codex", "thread-replacement", [text("continue")]);
    expect(c.prompts[0]).toEqual([text("continue")]);
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

    await gw.loadSession("cursor", "s-fresh-inband", { cwd: CWD });
    await gw.prompt("cursor", "s-fresh-inband", [text("hello")]);

    expect(c.prompts[0]).toHaveLength(2);
    expect((c.prompts[0]![0] as { text: string }).text).toContain(
      "<system_instruction>",
    );
  });
});
