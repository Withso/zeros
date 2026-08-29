// Coverage for applyBridgeAgentExit's session-scoping — the fix for
// "one Codex chat crashing flips EVERY open Codex chat to reconnecting."
//
// Codex runs one `codex app-server` child per chat, so the engine now
// emits a SESSION-SCOPED exit (AGENT_AGENT_EXITED carries a sessionId).
// The store must:
//   - flip ONLY the chat bound to that sessionId (siblings stay live),
//   - NOT cool the whole agent (other children are alive),
//   - leave an actively-driven chat (streaming/warming) alone — its
//     recovery is owned by the prompt-retry path,
// while a legacy agent-wide exit (no sessionId) still flips every chat
// and cools the agent.

import { beforeEach, describe, expect, it } from "vitest";

import { useSessionsStore, BLANK } from "../sessions-store";
import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

const seed = (
  chatId: string,
  agentId: string,
  sessionId: string,
  status: string,
) =>
  useSessionsStore.getState().setSession(chatId, {
    ...BLANK,
    agentId,
    sessionId,
    status: status as never,
  });

describe("applyBridgeAgentExit — session-scoped (Codex per-chat child)", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("flips only the matching chat; siblings on the same agent stay live", () => {
    seed("chatA", "codex", "sidA", "ready");
    seed("chatB", "codex", "sidB", "ready");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidA");

    const s = useSessionsStore.getState().sessions;
    expect(s["chatA"]?.status).toBe("reconnecting");
    expect(s["chatA"]?.sessionId).toBeNull();
    // Sibling untouched.
    expect(s["chatB"]?.status).toBe("ready");
    expect(s["chatB"]?.sessionId).toBe("sidB");
  });

  it("does NOT cool the whole agent on a session-scoped exit", () => {
    useSessionsStore.getState().setWarmAgent("codex", true);
    seed("chatA", "codex", "sidA", "ready");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidA");

    // Other Codex children are still alive — the pool stays warm.
    expect(useSessionsStore.getState().warmAgentIds.has("codex")).toBe(true);
  });

  it("leaves an actively-driven chat (streaming) alone — prompt-retry owns it", () => {
    seed("chatA", "codex", "sidA", "streaming");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidA");

    const slot = useSessionsStore.getState().sessions["chatA"];
    // A mid-turn crash on a streaming chat is recovered by the adapter's
    // recoverable transport-closed throw + sendPrompt rebuild — don't clobber
    // the sessionId out from under it here.
    expect(slot?.status).toBe("streaming");
    expect(slot?.sessionId).toBe("sidA");
  });

  it("leaves a warming chat alone too (a rebuild is in flight)", () => {
    seed("chatA", "codex", "sidA", "warming");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidA");

    expect(useSessionsStore.getState().sessions["chatA"]?.status).toBe(
      "warming",
    );
  });

  it("evicts a stale pendingPermission on exit even for a streaming chat", () => {
    // A streaming chat with an OPEN Allow/Deny gate: the subprocess dies, so the
    // canUseTool resolver is gone and the card can never resolve. The status is
    // still left to the prompt-retry path (streaming, session-scoped), but the
    // dead gate MUST be dropped — otherwise the composer stays concealed behind
    // a card wired to a dead permissionId (a second way a crashed chat wedged
    // input, alongside the failed-state read-only editor). Mirrors the
    // pendingQuestions eviction.
    useSessionsStore.getState().setSession("chatA", {
      ...BLANK,
      agentId: "claude",
      sessionId: "sidA",
      status: "streaming" as never,
      pendingPermission: {
        permissionId: "perm-1",
        agentId: "claude",
        request: {} as never,
      },
    });

    useSessionsStore.getState().applyBridgeAgentExit("claude", "sidA");

    const slot = useSessionsStore.getState().sessions["chatA"];
    expect(slot?.status).toBe("streaming"); // recovery still owned by prompt-retry
    expect(slot?.pendingPermission).toBeNull(); // …but the dead gate is gone
  });

  it("never downgrades a terminal chat (failed / auth-required)", () => {
    seed("chatA", "codex", "sidA", "failed");
    seed("chatB", "codex", "sidB", "auth-required");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidA");
    useSessionsStore.getState().applyBridgeAgentExit("codex", "sidB");

    expect(useSessionsStore.getState().sessions["chatA"]?.status).toBe(
      "failed",
    );
    expect(useSessionsStore.getState().sessions["chatB"]?.status).toBe(
      "auth-required",
    );
  });

  it("no-ops when the sessionId matches no live chat", () => {
    seed("chatA", "codex", "sidA", "ready");

    useSessionsStore.getState().applyBridgeAgentExit("codex", "does-not-exist");

    expect(useSessionsStore.getState().sessions["chatA"]?.status).toBe("ready");
    expect(useSessionsStore.getState().sessions["chatA"]?.sessionId).toBe(
      "sidA",
    );
  });
});

describe("applyBridgeAgentExit — agent-wide (no sessionId, shared subprocess)", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it("flips every non-terminal chat on the agent and cools it", () => {
    useSessionsStore.getState().setWarmAgent("claude", true);
    seed("chatA", "claude", "sidA", "ready");
    seed("chatB", "claude", "sidB", "streaming");
    seed("chatC", "cursor", "sidC", "ready");

    useSessionsStore.getState().applyBridgeAgentExit("claude");

    const s = useSessionsStore.getState().sessions;
    // Both claude chats flip — the agent-wide path has no per-chat
    // prompt-retry to defer to, so even a streaming chat resets.
    expect(s["chatA"]?.status).toBe("reconnecting");
    expect(s["chatB"]?.status).toBe("reconnecting");
    // A different agent is untouched.
    expect(s["chatC"]?.status).toBe("ready");
    // The whole agent cools.
    expect(useSessionsStore.getState().warmAgentIds.has("claude")).toBe(false);
  });
});

describe("territory-revoked execution routing", () => {
  beforeEach(() => {
    useSessionsStore.getState().clearAll();
  });

  it.each(["codex", "claude", "cursor"])(
    "invalidates only the exact retired %s execution before the next prompt",
    (agentId) => {
      seed("chatA", agentId, "retired-execution", "streaming");
      seed("chatB", agentId, "replacement-execution", "ready");
      const state = useSessionsStore.getState();
      const providerBinding = {
        version: 1 as const,
        providerId: agentId,
        kind: "native" as const,
        resumeId: `${agentId}-durable-thread`,
      };
      state.patchSession("chatA", { providerBinding });
      const revoked = {
        version: 1,
        actor: "agent-code",
        state: "revoked",
        backend: "zeros-srt",
        designProtection: {
          required: true,
          enforced: true,
          protectedDirectoryCount: 1,
        },
        parity: { level: "full", restrictions: [] },
        checkedAt: Date.now(),
      } satisfies ExecutionBoundaryStatus;

      state.applyBridgeBoundaryStatus(agentId, "retired-execution", revoked);

      const sessions = useSessionsStore.getState().sessions;
      expect(sessions["chatA"]).toMatchObject({
        status: "reconnecting",
        executionId: null,
        sessionId: null,
        boundary: null,
        providerBinding,
      });
      expect(sessions["chatB"]?.sessionId).toBe("replacement-execution");

      // A delayed terminal event from that retired execution must not clobber
      // a route subsequently admitted for the same chat.
      seed("chatA", agentId, "new-execution", "ready");
      state.applyBridgeBoundaryStatus(agentId, "retired-execution", revoked);
      expect(useSessionsStore.getState().sessions["chatA"]?.executionId).toBe(
        "new-execution",
      );
    },
  );

  it("fails only the exact execution when background Design protection fails", () => {
    seed("chatA", "codex", "failed-execution", "streaming");
    seed("chatB", "codex", "healthy-execution", "ready");
    const failed = {
      version: 1,
      actor: "agent-code",
      state: "unavailable",
      backend: "zeros-srt",
      designProtection: {
        required: true,
        enforced: false,
        protectedDirectoryCount: 1,
      },
      parity: { level: "full", restrictions: [] },
      checkedAt: Date.now(),
      failure: "design-protection-failed",
    } as ExecutionBoundaryStatus & {
      failure: "design-protection-failed";
    };

    useSessionsStore
      .getState()
      .applyBridgeBoundaryStatus("codex", "failed-execution", failed);

    expect(useSessionsStore.getState().sessions["chatA"]).toMatchObject({
      status: "failed",
      activeTurnStartedAt: null,
      failure: {
        kind: "design-protection-failed",
        stage: "prompt",
      },
    });
    expect(useSessionsStore.getState().sessions["chatB"]).toMatchObject({
      status: "ready",
      sessionId: "healthy-execution",
      failure: null,
    });
  });
});
