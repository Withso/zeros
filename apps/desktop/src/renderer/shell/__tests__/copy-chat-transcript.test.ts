// Outcome contract for the chat tab's "Copy … transcript" action. Every
// distinct outcome gets its OWN toast so a failed pick is never a dead end,
// a partial copy is never reported as whole, and nothing escapes as an
// unhandled rejection (the menu item fires this as a bare `void` call).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  loadFullTranscript: vi.fn(),
  copyToClipboardWithFallback: vi.fn(),
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock("../../features/agent/agent-history-client", () => ({
  loadFullTranscript: mocks.loadFullTranscript,
}));
vi.mock("../../shared/ui/primitives/elements", () => ({ toast: mocks.toast }));
vi.mock("../../shared/lib/clipboard", () => ({
  copyToClipboardWithFallback: mocks.copyToClipboardWithFallback,
}));

import { copyChatTranscript } from "../copy-chat-transcript";
import type { AgentMessage } from "@zeros/protocol/agent-messages";

/** One user prompt + one answer — enough for a non-empty transcript. */
function conversation(): AgentMessage[] {
  return [
    {
      id: "m1",
      kind: "text",
      role: "user",
      text: "ask",
      createdAt: 1,
    } as AgentMessage,
    {
      id: "m2",
      kind: "text",
      role: "agent",
      text: "answer",
      createdAt: 2,
    } as AgentMessage,
  ];
}

function loaded(messages: AgentMessage[], complete = true) {
  return { messages, complete };
}

beforeEach(() => {
  // reset, not clear: clearAllMocks keeps implementations, so a pending-promise
  // stub from one test would leak into the next.
  mocks.loadFullTranscript.mockReset();
  mocks.copyToClipboardWithFallback.mockReset();
  mocks.toast.success.mockReset();
  mocks.toast.error.mockReset();
  mocks.toast.info.mockReset();
  mocks.toast.warning.mockReset();
  mocks.copyToClipboardWithFallback.mockResolvedValue(true);
});

describe("copyChatTranscript", () => {
  it("writes the formatted transcript and reports success", async () => {
    mocks.loadFullTranscript.mockResolvedValue(loaded(conversation()));

    await copyChatTranscript("c1", "full", { title: "Flamingo" });

    const written = mocks.copyToClipboardWithFallback.mock.calls[0][0] as string;
    expect(written).toContain("# Flamingo");
    expect(written).toContain("ask");
    expect(written).toContain("answer");
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
    expect(mocks.toast.warning).not.toHaveBeenCalled();
  });

  it("warns instead of claiming success when the walk stopped early", async () => {
    mocks.loadFullTranscript.mockResolvedValue(loaded(conversation(), false));

    await copyChatTranscript("c1", "full", {});

    expect(mocks.toast.warning).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(String(mocks.toast.warning.mock.calls[0][0])).toContain(
      "most recent",
    );
  });

  it("reports an engine read failure without leaking the internal message", async () => {
    mocks.loadFullTranscript.mockRejectedValue(
      new Error("workspace op 'messages.windowOlder' failed"),
    );
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await copyChatTranscript("c1", "full", {});
    err.mockRestore();

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    const msg = String(mocks.toast.error.mock.calls[0][0]);
    expect(msg).not.toContain("workspace op");
    expect(mocks.copyToClipboardWithFallback).not.toHaveBeenCalled();
  });

  it("says so for an empty chat instead of copying an empty document", async () => {
    mocks.loadFullTranscript.mockResolvedValue(loaded([]));

    await copyChatTranscript("c1", "full", {});

    expect(mocks.toast.info).toHaveBeenCalledTimes(1);
    expect(mocks.copyToClipboardWithFallback).not.toHaveBeenCalled();
  });

  it("points at the full transcript when concise has no answers", async () => {
    // A turn that never produced an answer yields zero concise sections.
    mocks.loadFullTranscript.mockResolvedValue(
      loaded([
        {
          id: "m1",
          kind: "text",
          role: "user",
          text: "ask",
          createdAt: 1,
        } as AgentMessage,
      ]),
    );

    await copyChatTranscript("c1", "concise", {});

    // The prompt alone is still a turn, so this copies rather than bailing.
    expect(mocks.copyToClipboardWithFallback).toHaveBeenCalledTimes(1);
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });

  it("reports a rejected clipboard write", async () => {
    mocks.loadFullTranscript.mockResolvedValue(loaded(conversation()));
    mocks.copyToClipboardWithFallback.mockResolvedValue(false);

    await copyChatTranscript("c1", "full", {});

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
    expect(String(mocks.toast.error.mock.calls[0][0])).toContain("clipboard");
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("never rejects, so the menu item's bare `void` call can't crash", async () => {
    mocks.loadFullTranscript.mockResolvedValue(loaded(conversation()));
    mocks.copyToClipboardWithFallback.mockRejectedValue(new Error("boom"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      copyChatTranscript("c1", "full", {}),
    ).resolves.toBeUndefined();
    err.mockRestore();

    expect(mocks.toast.error).toHaveBeenCalledTimes(1);
  });

  it("dedupes a repeated pick but not a different tab or mode", async () => {
    // One resolver per call — a single shared `release` would strand the
    // earlier promises and hang the test.
    const releases: Array<(v: unknown) => void> = [];
    mocks.loadFullTranscript.mockImplementation(
      () => new Promise((r) => releases.push(r)),
    );

    const started = [
      copyChatTranscript("c1", "full", {}),
      // Same chat + mode while in flight → dropped.
      copyChatTranscript("c1", "full", {}),
    ];
    expect(mocks.loadFullTranscript).toHaveBeenCalledTimes(1);

    // A different mode, and a different chat, must still go through.
    started.push(copyChatTranscript("c1", "concise", {}));
    started.push(copyChatTranscript("c2", "full", {}));
    expect(mocks.loadFullTranscript).toHaveBeenCalledTimes(3);

    for (const r of releases) r(loaded(conversation()));
    await Promise.all(started);
  });

  it("frees the in-flight key after a failure so a retry works", async () => {
    mocks.loadFullTranscript.mockRejectedValueOnce(new Error("nope"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await copyChatTranscript("c1", "full", {});

    mocks.loadFullTranscript.mockResolvedValue(loaded(conversation()));
    await copyChatTranscript("c1", "full", {});
    err.mockRestore();

    expect(mocks.loadFullTranscript).toHaveBeenCalledTimes(2);
    expect(mocks.toast.success).toHaveBeenCalledTimes(1);
  });
});
