// gateway.prompt — working-directory hint injection. An agent that doesn't
// tell its own model the cwd (one NOT in CWD_SELF_AWARE_AGENTS) starts a turn
// blind: the model guesses a path on its first write, hits the wrong (often
// read-only) location, and only recovers after running `pwd`. The gateway
// prepends a one-shot cwd note for such an agent on the first prompt of a
// session. Today every active agent (claude/codex/cursor) self-reports, so
// these tests pin the mechanism with a synthetic non-self-aware agent id.

import os from "node:os";

import { describe, expect, it } from "vitest";

import { AgentGateway } from "../gateway";
import type { AgentAdapter, ContentBlock, PromptResponse } from "../types";

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
  executionToAgent: Map<string, string>;
  executionToCwd: Map<string, string>;
  sessionsCwdHinted: Set<string>;
  sessionsInstructed: Set<string>;
  executionToInstructionCtx: Map<
    string,
    {
      additionalDirectories: string[];
      targetBranch?: string;
      customInstructions?: string;
    }
  >;
  prompt(
    agentId: string,
    sessionId: string,
    prompt: ContentBlock[],
  ): Promise<PromptResponse>;
};

/** A fake adapter that records every prompt array it is handed. */
function recordingAdapter(
  agentId: string,
  sink: ContentBlock[][],
): AgentAdapter {
  return {
    agentId,
    prompt: async ({ prompt }: { prompt: ContentBlock[] }) => {
      sink.push(prompt);
      return { response: {} as PromptResponse };
    },
  } as unknown as AgentAdapter;
}

function text(t: string): ContentBlock {
  return { type: "text", text: t };
}

/** Wire a session into the gateway's internal maps as if newSession had run. */
function bind(
  gw: GwInternals,
  agentId: string,
  sessionId: string,
  sink: ContentBlock[][],
  cwd?: string,
) {
  gw.adapters.set(agentId, recordingAdapter(agentId, sink));
  gw.executionToAgent.set(sessionId, agentId);
  if (cwd) gw.executionToCwd.set(sessionId, cwd);
  // Pre-mark instructed so these cwd-hint tests isolate the cwd hint from the
  // first-turn <system_instruction> (which now also injects via prompt()).
  gw.sessionsInstructed.add(sessionId);
}

/** Like bind(), but leaves the session UN-instructed so prompt() fires the
 *  first-turn <system_instruction> — for the system-instruction tests. */
function bindFresh(
  gw: GwInternals,
  agentId: string,
  sessionId: string,
  sink: ContentBlock[][],
  cwd?: string,
  ctx?: {
    additionalDirectories?: string[];
    targetBranch?: string;
    customInstructions?: string;
  },
) {
  gw.adapters.set(agentId, recordingAdapter(agentId, sink));
  gw.executionToAgent.set(sessionId, agentId);
  if (cwd) gw.executionToCwd.set(sessionId, cwd);
  gw.executionToInstructionCtx.set(sessionId, {
    additionalDirectories: ctx?.additionalDirectories ?? [],
    targetBranch: ctx?.targetBranch,
    customInstructions: ctx?.customInstructions,
  });
}

describe("AgentGateway.prompt cwd hint", () => {
  it("prepends a cwd hint for a non-self-aware agent on the FIRST prompt only", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    // A hypothetical future backend that does NOT self-report its cwd.
    bind(gw, "future-agent", "s1", sink, "/Users/me/wt/abc");

    await gw.prompt("future-agent", "s1", [text("write greeting.md")]);
    await gw.prompt("future-agent", "s1", [text("now add a heading")]);

    // First prompt: hint block prepended ahead of the user's text.
    expect(sink[0]).toHaveLength(2);
    const hint = sink[0]![0]!;
    expect(hint.type).toBe("text");
    expect((hint as { text: string }).text).toContain("/Users/me/wt/abc");
    expect((hint as { text: string }).text.toLowerCase()).toContain(
      "working directory",
    );
    expect(sink[0]![1]).toEqual(text("write greeting.md"));

    // Second prompt: no hint — the agent already knows where it is.
    expect(sink[1]).toHaveLength(1);
    expect(sink[1]![0]).toEqual(text("now add a heading"));
  });

  it("does NOT prepend for claude (it injects <env> via the claude_code preset)", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bind(gw, "claude", "s2", sink, "/Users/me/wt/abc");

    await gw.prompt("claude", "s2", [text("hello")]);

    expect(sink[0]).toHaveLength(1);
    expect(sink[0]![0]).toEqual(text("hello"));
    expect(gw.sessionsCwdHinted.has("s2")).toBe(false);
  });

  it("does NOT prepend for codex (it injects <cwd> natively)", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bind(gw, "codex", "s3", sink, "/Users/me/wt/abc");

    await gw.prompt("codex", "s3", [text("hello")]);

    expect(sink[0]).toHaveLength(1);
    expect(sink[0]![0]).toEqual(text("hello"));
  });

  it("does NOT prepend for cursor (it sends workspace_root_path to its model)", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bind(gw, "cursor", "s5", sink, "/Users/me/wt/abc");

    await gw.prompt("cursor", "s5", [text("hello")]);

    expect(sink[0]).toHaveLength(1);
    expect(sink[0]![0]).toEqual(text("hello"));
    expect(gw.sessionsCwdHinted.has("s5")).toBe(false);
  });

  it("is a no-op when the session has no cwd on file (never hint blindly)", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bind(gw, "future-agent", "s4", sink); // non-self-aware, but no cwd on file

    await gw.prompt("future-agent", "s4", [text("hello")]);

    expect(sink[0]).toHaveLength(1);
    expect(gw.sessionsCwdHinted.has("s4")).toBe(false);
  });
});

describe("AgentGateway.prompt system instruction", () => {
  it("prepends the workspace preamble for EVERY agent, FIRST prompt only", async () => {
    for (const agentId of ["claude", "codex", "cursor", "future-agent"]) {
      const gw = makeGateway() as unknown as GwInternals;
      const sink: ContentBlock[][] = [];
      bindFresh(gw, agentId, "si", sink, "/ws/foo");
      await gw.prompt(agentId, "si", [text("hi")]);
      await gw.prompt(agentId, "si", [text("again")]);
      // First prompt: <system_instruction> is the outermost block; user text last.
      const head = sink[0]![0] as { text: string };
      expect(head.text).toContain("<system_instruction>");
      expect(head.text).toContain("working inside Zeros");
      expect(head.text).toContain("/ws/foo");
      expect(sink[0]![sink[0]!.length - 1]).toEqual(text("hi"));
      // Second prompt: no re-injection.
      expect(sink[1]).toEqual([text("again")]);
    }
  });

  it("includes the /add-dir awareness when additional dirs are present", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bindFresh(gw, "claude", "si2", sink, "/ws", {
      additionalDirectories: ["/x/lewisia", "/x/petunia"],
    });
    await gw.prompt("claude", "si2", [text("hi")]);
    const head = (sink[0]![0] as { text: string }).text;
    expect(head).toContain("/x/lewisia");
    expect(head).toContain("/x/petunia");
    expect(head.toLowerCase()).toContain("additional directories");
  });

  it("includes repo prompts.general custom instructions", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bindFresh(gw, "claude", "si3", sink, "/ws", {
      customInstructions: "Always reply in French.",
    });
    await gw.prompt("claude", "si3", [text("hi")]);
    expect((sink[0]![0] as { text: string }).text).toContain(
      "Always reply in French.",
    );
  });

  it("does NOT inject on a pre-marked (resumed) session", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bind(gw, "claude", "si4", sink, "/ws"); // bind() pre-marks instructed
    await gw.prompt("claude", "si4", [text("hi")]);
    expect(sink[0]).toEqual([text("hi")]);
  });

  it("is a no-op when the session has no cwd", async () => {
    const gw = makeGateway() as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    bindFresh(gw, "claude", "si5", sink); // no cwd
    await gw.prompt("claude", "si5", [text("hi")]);
    expect(sink[0]).toEqual([text("hi")]);
  });
});

/** A fake adapter whose loadSession reports a configurable `resumedFresh`
 *  (Codex stale-rollout / Cursor "agent not found" / Claude no-session-id all
 *  surface this) and records the prompts it's handed. */
function resumingAdapter(
  agentId: string,
  sink: ContentBlock[][],
  resumedFresh: boolean,
): AgentAdapter {
  return {
    agentId,
    loadSession: async () => ({
      modes: { currentModeId: "default", availableModes: [] },
      resumedFresh,
    }),
    prompt: async ({ prompt }: { prompt: ContentBlock[] }) => {
      sink.push(prompt);
      return { response: {} as PromptResponse };
    },
  } as unknown as AgentAdapter;
}

describe("AgentGateway.loadSession re-arms the system instruction on a degraded resume", () => {
  it("RE-injects <system_instruction> when the resume degraded to a FRESH thread", async () => {
    const gw = makeGateway();
    const gwi = gw as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    gwi.adapters.set("claude", resumingAdapter("claude", sink, true));

    // A real existing dir so resolveAgentCwd accepts the cwd.
    const loaded = await gw.loadSession("claude", "fresh-1", {
      cwd: os.tmpdir(),
    });
    const executionId = loaded.executionId!;
    // A degraded resume must NOT be pre-marked instructed (the fresh thread has
    // no transcript carrying the preamble).
    expect(executionId).not.toBe("fresh-1");
    expect(gwi.sessionsInstructed.has(executionId)).toBe(false);

    await gw.prompt("claude", executionId, [text("hi")]);
    const head = sink[0]![0] as { text: string };
    expect(head.text).toContain("<system_instruction>");
    expect(head.text).toContain("working inside Zeros");
    expect(head.text).toContain(os.tmpdir());
    expect(sink[0]![sink[0]!.length - 1]).toEqual(text("hi"));
  });

  it("does NOT re-inject on a TRUE resume (transcript already carries it)", async () => {
    const gw = makeGateway();
    const gwi = gw as unknown as GwInternals;
    const sink: ContentBlock[][] = [];
    gwi.adapters.set("codex", resumingAdapter("codex", sink, false));

    const loaded = await gw.loadSession("codex", "true-1", {
      cwd: os.tmpdir(),
    });
    const executionId = loaded.executionId!;
    expect(executionId).not.toBe("true-1");
    expect(gwi.sessionsInstructed.has(executionId)).toBe(true);

    await gw.prompt("codex", executionId, [text("hi")]);
    expect(sink[0]).toEqual([text("hi")]);
  });
});
