// gateway newSession/loadSession — NATIVE system-instruction routing. An
// adapter declaring `nativeSystemInstruction` (Codex) receives Zeros'
// first-turn orientation as the UNWRAPPED `systemInstruction` opt at session
// create/resume — it delivers it on the protocol's own instruction field
// (thread/start|resume.developerInstructions) — and the gateway pre-marks the
// session instructed so the first prompt is NOT also prepended with the
// in-band <system_instruction> block. Adapters without the flag keep the
// legacy mechanism A untouched.

import os from "node:os";

import { describe, expect, it } from "vitest";

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
