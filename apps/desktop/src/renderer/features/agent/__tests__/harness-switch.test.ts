import { describe, expect, it, vi } from "vitest";
import {
  buildHarnessSwitchMessage,
  canAutoContinueAfterSwitch,
  switchContinuation,
  commitHarnessSwitch,
  refreshChatTurnRows,
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
import { turnRowKey } from "../../../state/read-caches";
import { KeyedAsyncCache } from "../../../shared/lib/keyed-async-cache";

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

  it("auto-continues only with the seeded transcript alone", () => {
    const transcript = { name: "transcript.md" };
    expect(canAutoContinueAfterSwitch({ displayText: "  ", attachments: [transcript] })).toBe(true);
    expect(canAutoContinueAfterSwitch({ displayText: "half a thought", attachments: [transcript] })).toBe(false);
    expect(canAutoContinueAfterSwitch({ displayText: "", attachments: [transcript, { name: "a.png" }] })).toBe(false);
    expect(canAutoContinueAfterSwitch({ displayText: "", attachments: [] })).toBe(false);
    expect(canAutoContinueAfterSwitch(null)).toBe(false);
  });

  it("waits for the seeded transcript to reach the composer before deciding", () => {
    const pending = { chatId: "c1", agentId: "cursor", sourceKey: "transcript:c1" };
    const empty = { displayText: "", attachments: [] };
    const seeded = { displayText: " ", attachments: [{ name: "c1.handoff.txt" }] };
    const at = (over: Partial<Parameters<typeof switchContinuation>[1]> = {}) =>
      switchContinuation(pending, { chatId: "c1", agentId: "cursor", stagedSourceKeys: [], composer: empty, ...over });
    expect(at()).toBe("wait");
    expect(at({ agentId: "codex", stagedSourceKeys: ["transcript:c1"], composer: seeded })).toBe("wait");
    expect(at({ chatId: "c2", stagedSourceKeys: ["transcript:c1"], composer: seeded })).toBe("wait");
    expect(at({ stagedSourceKeys: ["transcript:c1"], composer: seeded })).toBe("send");
    expect(at({ stagedSourceKeys: ["transcript:c1"], composer: { ...seeded, displayText: "mine" } })).toBe("ask");
    expect(switchContinuation(null, { chatId: "c1", agentId: "cursor", stagedSourceKeys: [], composer: empty })).toBe("wait");
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
    const cache = new KeyedAsyncCache<{ status: string } | null>(8);
    const stopped = turnRowKey("c1", "user-1");
    const other = turnRowKey("c10", "user-1");
    cache.setData(stopped, { status: "running" });
    cache.setData(other, { status: "running" });
    const seen: string[] = [];
    cache.subscribe(stopped, () => seen.push(stopped));
    cache.subscribe(other, () => seen.push(other));
    refreshChatTurnRows(cache, "c1");
    expect(seen).toEqual([stopped]);
  });
});
