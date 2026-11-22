import { describe, expect, it, vi } from "vitest";
import {
  buildHarnessSwitchMessage,
  handoffContextPrefix,
  stagedPickOnSend,
  commitHarnessSwitch,
  type HarnessSwitchCommit,
  harnessSwitchBlockedByQueue,
  harnessSwitchTranscriptMode,
  isHarnessChange,
  isHarnessSwitchMessage,
  isPendingPick,
} from "../harness-switch";
import { partitionTurn } from "../turn-partition";
import { metaForEvent } from "../renderers/event-meta";
import { isProviderWorkEvent } from "../transcript-notices";
import { buildForkTranscriptAttachment } from "../fork-chat";
import type { AgentMessage } from "../use-agent-session";
import { refreshChatTurnRows, turnRowCache, turnRowKey } from "../../../state/read-caches";
import type { TurnInfo } from "../../../platform/turns";

const row = (to = { agentId: "codex", model: "gpt-5.1-codex" }) =>
  buildHarnessSwitchMessage({
    id: "switch-1",
    from: { agentId: "claude", model: "opus" },
    to,
    now: 10,
  });

describe("harness switch", () => {
  it("treats a provider family change as a harness change", () => {
    expect(isHarnessChange("claude", "codex")).toBe(true);
    expect(isHarnessChange("claude-code", "claude")).toBe(false);
    expect(isHarnessChange(null, "cursor")).toBe(true);
  });

  it("stages only picks that differ from the active agent and model", () => {
    const active = { agentId: "claude", model: "opus" };
    expect(isPendingPick(null, active)).toBe(false);
    expect(isPendingPick({ agentId: "claude", model: "opus" }, active)).toBe(false);
    expect(isPendingPick({ agentId: "claude", model: "sonnet" }, active)).toBe(true);
    expect(isPendingPick({ agentId: "codex", model: "opus" }, active)).toBe(true);
  });

  it("seeds the next harness from the handoff transcript", () => {
    expect(harnessSwitchTranscriptMode()).toBe("handoff");
    expect(buildForkTranscriptAttachment({
      sourceChatId: "chat-1", sourceLabel: "Fix login", text: "t", mode: "handoff",
    }).name).not.toBe(buildForkTranscriptAttachment({
      sourceChatId: "chat-1", sourceLabel: "Fix login", text: "t",
    }).name);
  });

  it("records a completed tool row naming the new model", () => {
    const message = row();
    expect(message.title).toMatch(/^Switched to /);
    expect(message.status).toBe("completed");
    expect(isHarnessSwitchMessage(message)).toBe(true);
    expect(message.rawInput).toMatchObject({ harnessChanged: true, fromAgentId: "claude", toAgentId: "codex" });
    expect(row({ agentId: "claude", model: "sonnet" }).rawInput).toMatchObject({ harnessChanged: false });
  });

  it("renders as a static row with the switch title", () => {
    const meta = metaForEvent(row());
    expect(meta.label).toBe(row().title);
    expect(meta.expandable).toBe(false);
  });

  it("is not provider work, so it never extends a turn's activity", () => {
    expect(isProviderWorkEvent(row())).toBe(false);
  });

  it("stays visible mid-turn and after the answer instead of folding into work", () => {
    const tool = { kind: "tool", id: "t1", toolCallId: "t1", toolKind: "read", status: "completed", title: "Read", rawInput: {}, createdAt: 1 } as unknown as AgentMessage;
    const answer = { kind: "text", role: "agent", id: "a1", text: "done", createdAt: 3 } as unknown as AgentMessage;
    const mid = partitionTurn([tool, row(), tool], { live: true });
    expect(mid.finalOutput.map((m) => m.id)).toContain("switch-1");
    expect(mid.working.map((m) => m.id)).not.toContain("switch-1");
    const settled = partitionTurn([tool, answer, row()], { live: false });
    expect(settled.finalOutput.map((m) => m.id)).toEqual(["a1", "switch-1"]);
  });
});

describe("harness switch guards", () => {
  it("waits for queued follow-ups only when the harness changes", () => {
    expect(harnessSwitchBlockedByQueue(true, 1)).toBe(true);
    expect(harnessSwitchBlockedByQueue(true, 0)).toBe(false);
    expect(harnessSwitchBlockedByQueue(false, 2)).toBe(false);
  });

});

describe("handoff context prefix", () => {
  it("frames the earlier conversation as context before the user's message", () => {
    const prefix = handoffContextPrefix({ fromLabel: 'GPT "6"', text: "## User\n\nfix it\n" });
    expect(prefix.startsWith('<context_handoff from="GPT \'6\'">')).toBe(true);
    expect(prefix).toContain("not a new request");
    expect(prefix).toContain("## User\n\nfix it\n</context_handoff>");
    expect(`${prefix}hello`.endsWith("User message:\nhello")).toBe(true);
    expect(prefix).not.toContain("omitted");
    expect(handoffContextPrefix({ fromLabel: "a", text: "t", complete: false })).toContain("omitted");
  });
});

describe("staged pick on send", () => {
  const base = { harnessChanged: true, hasDraft: true, queuedCount: 0, running: false, behavior: "queue" as const };
  it("changes the model with the message, even mid-turn", () => {
    expect(stagedPickOnSend({ ...base, harnessChanged: false, running: true })).toBe("model");
  });
  it("leaves an empty composer and the staged pick alone", () => {
    expect(stagedPickOnSend({ ...base, hasDraft: false })).toBe("none");
  });
  it("waits for the running turn instead of stopping it", () => {
    expect(stagedPickOnSend({ ...base, running: true })).toBe("hold");
  });
  it("restarts in the new harness only on an explicit steer", () => {
    expect(stagedPickOnSend({ ...base, running: true, behavior: "steer" })).toBe("restart");
    expect(stagedPickOnSend(base)).toBe("switch");
  });
  it("refuses a harness change while follow-ups are queued", () => {
    expect(stagedPickOnSend({ ...base, queuedCount: 1 })).toBe("blocked");
  });
});

describe("commit harness switch", () => {
  const steps = (cloud: boolean, outcome: HarnessSwitchCommit | Error = "switched", current = true) => {
    const calls: string[] = [];
    const run = commitHarnessSwitch({
      cloud,
      switchCloudAgent: async () => {
        calls.push("worker switch");
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      recordRow: async () => { calls.push(cloud ? "show row" : "save row"); },
      closeSession: () => { calls.push("close session"); return Promise.reject(new Error("closed already")); },
      stillCurrent: () => current,
      updateSettings: () => { calls.push("update settings"); },
    });
    return { calls, run };
  };

  it("switches the cloud worker before the renderer's settings upsert", async () => {
    const { calls, run } = steps(true);
    await expect(run).resolves.toBe("switched");
    expect(calls).toEqual(["worker switch", "show row", "close session", "update settings"]);
  });

  it("leaves the chat untouched when an older cloud worker lacks the switch", async () => {
    const { calls, run } = steps(true, "unsupported");
    await expect(run).resolves.toBe("unsupported");
    expect(calls).toEqual(["worker switch"]);
  });

  it("stops when the worker chat already left the previous agent", async () => {
    const { calls, run } = steps(true, "stale");
    await expect(run).resolves.toBe("stale");
    expect(calls).toEqual(["worker switch"]);
  });

  it("surfaces a worker refusal without changing settings", async () => {
    const { calls, run } = steps(true, new Error("Send or remove queued messages before switching agent."));
    await expect(run).rejects.toThrow(/queued messages/);
    expect(calls).toEqual(["worker switch"]);
  });

  it("saves the Local row and never calls the cloud worker", async () => {
    const { calls, run } = steps(false);
    await expect(run).resolves.toBe("switched");
    expect(calls).toEqual(["save row", "close session", "update settings"]);
  });

  it("skips the settings change when the chat moved on meanwhile", async () => {
    const update = vi.fn();
    await expect(commitHarnessSwitch({
      cloud: false,
      switchCloudAgent: async () => "switched",
      recordRow: async () => {},
      closeSession: () => undefined,
      stillCurrent: () => false,
      updateSettings: update,
    })).resolves.toBe("stale");
    expect(update).not.toHaveBeenCalled();
  });

  it("marks only the switched chat's cached turn rows stale", () => {
    const row = (status: string) => ({ status }) as unknown as TurnInfo;
    const stopped = turnRowKey("c1", "user-1");
    const settled = turnRowKey("c1", "user-0");
    const other = turnRowKey("c10", "user-1");
    turnRowCache.setData(stopped, row("running"));
    turnRowCache.setData(settled, row("completed"));
    turnRowCache.setData(other, row("running"));
    const seen: string[] = [];
    const offs = [stopped, settled, other].map((key) => turnRowCache.subscribe(key, () => seen.push(key)));
    refreshChatTurnRows("c1", true);
    expect(seen).toEqual([stopped]);
    refreshChatTurnRows("c1");
    expect(seen).toEqual([stopped, stopped, settled]);
    offs.forEach((off) => off());
  });
});
