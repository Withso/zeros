import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useWorkspaceFileDiffSnapshot = vi.hoisted(() =>
  vi.fn(() => ({
    data: undefined,
    error: null,
    loading: false,
    stale: true,
  })),
);

vi.mock(
  "@/renderer/shell/workspace-file-data-cache",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/renderer/shell/workspace-file-data-cache")
    >()),
    useWorkspaceFileDiffSnapshot,
  }),
);

import {
  canForkTurn,
  canPreviewTurnFileDiff,
  isInterruptedTurn,
  TurnFilePill,
  TurnFooter,
  turnFooterFiles,
  turnFooterStatusLabel,
} from "../turn-footer";
import { TooltipProvider } from "@/renderer/shared/ui/primitives/tooltip";
import { pickStartedAt } from "../activity-hud";
import { ActionsCtx } from "../sessions-context";
import { turnRowCache, turnRowKey } from "@/renderer/state/read-caches";
import type { TurnInfo } from "@/renderer/platform/turns";

describe("TurnFilePill cache ownership", () => {
  beforeEach(() => useWorkspaceFileDiffSnapshot.mockClear());

  const renderPill = (additions: number, deletions: number) =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(TurnFilePill, {
          file: {
            path: "src/history.ts",
            status: "modified",
            additions,
            deletions,
          },
          chatId: "chat-1",
          turnId: "turn-1",
          workspaceId: "workspace-1",
          onOpen: vi.fn(),
        }),
      ),
    );

  it("does not subscribe closed previewable pills to the shared diff cache", () => {
    renderPill(1, 1);
    expect(useWorkspaceFileDiffSnapshot).not.toHaveBeenCalled();
  });

  it("never subscribes metadata-only pills to the shared diff cache", () => {
    renderPill(0, 0);
    expect(useWorkspaceFileDiffSnapshot).not.toHaveBeenCalled();
  });
});

describe("turnFooterFiles", () => {
  it("does not invent a pill when the persisted turn says no file changed", () => {
    expect(turnFooterFiles({ files: [] })).toEqual([]);
    expect(turnFooterFiles(null)).toEqual([]);
  });

  it("uses the persisted snapshot diff when a file really changed", () => {
    const files = [
      {
        path: "deleted.txt",
        status: "deleted" as const,
        additions: 0,
        deletions: 4,
      },
    ];
    expect(turnFooterFiles({ files })).toBe(files);
  });
});

describe("pickStartedAt", () => {
  it("keeps the original turn clock while a re-adopted turn has no new events", () => {
    expect(pickStartedAt([], 1234)).toBe(1234);
  });

  it("never restarts the clock when a slow first frame lands late", () => {
    // Cursor's cold session takes 10s+ to its first frame, and provider events
    // are stamped on ARRIVAL. Anchoring to events[0] made the live timer count
    // to 12s, snap to 0s, then settle at ~1s for a 13s turn.
    const turnStartedAt = 1_000_000;
    const firstFrame = {
      kind: "text",
      role: "assistant",
      createdAt: turnStartedAt + 11_500,
    } as unknown as Parameters<typeof pickStartedAt>[0][number];
    expect(pickStartedAt([firstFrame], turnStartedAt)).toBe(turnStartedAt);
  });

  it("falls back to the first event when the turn start is unknown", () => {
    const firstFrame = {
      kind: "text",
      role: "assistant",
      createdAt: 5_000,
    } as unknown as Parameters<typeof pickStartedAt>[0][number];
    // 0 is the "no user message yet" sentinel — clamping to it would date the
    // timer to the epoch.
    expect(pickStartedAt([firstFrame], 0)).toBe(5_000);
    expect(pickStartedAt([firstFrame])).toBe(5_000);
  });

  it("does not re-anchor to a running tool — the turn clock only goes up", () => {
    // Re-anchoring made the timer read 0s at the start of every tool and jump
    // back to the real elapsed when it finished, several times per turn, on
    // every provider. Per-tool elapsed lives on the tool row's own chip.
    const events = [
      { kind: "text", role: "assistant", createdAt: 1_000 },
      { kind: "tool", status: "in_progress", createdAt: 4_000 },
    ] as unknown as Parameters<typeof pickStartedAt>[0];
    expect(pickStartedAt(events, 500)).toBe(500);
    expect(pickStartedAt(events)).toBe(1_000);
  });

  it("is monotonic as tools start and finish across a turn", () => {
    const turnStartedAt = 1_000;
    const events: Parameters<typeof pickStartedAt>[0] = [];
    const push = (e: Record<string, unknown>) =>
      events.push(e as unknown as Parameters<typeof pickStartedAt>[0][number]);
    const seen: number[] = [];
    push({ kind: "text", role: "thought", createdAt: 2_000 });
    seen.push(pickStartedAt(events, turnStartedAt));
    push({ kind: "tool", status: "in_progress", createdAt: 3_000 });
    seen.push(pickStartedAt(events, turnStartedAt));
    events[1] = {
      kind: "tool",
      status: "completed",
      createdAt: 3_000,
    } as unknown as Parameters<typeof pickStartedAt>[0][number];
    seen.push(pickStartedAt(events, turnStartedAt));
    push({ kind: "tool", status: "in_progress", createdAt: 7_000 });
    seen.push(pickStartedAt(events, turnStartedAt));
    expect(seen).toEqual([
      turnStartedAt,
      turnStartedAt,
      turnStartedAt,
      turnStartedAt,
    ]);
  });
});

describe("canPreviewTurnFileDiff", () => {
  it("previews persisted textual change pills, including one-sided writes and deletes", () => {
    expect(canPreviewTurnFileDiff({ additions: 1, deletions: 1 })).toBe(true);
    expect(canPreviewTurnFileDiff({ additions: 3, deletions: 0 })).toBe(true);
    expect(canPreviewTurnFileDiff({ additions: 0, deletions: 4 })).toBe(true);
  });

  it("keeps metadata-only 0/0 pills on the lightweight path", () => {
    expect(canPreviewTurnFileDiff({ additions: 0, deletions: 0 })).toBe(false);
  });
});

describe("canForkTurn", () => {
  it("requires a settled turn with actual agent output", () => {
    expect(canForkTurn(false, "final answer")).toBe(true);
    expect(canForkTurn(true, "partial streamed answer")).toBe(false);
    expect(canForkTurn(false, "")).toBe(false);
  });
});

describe("isInterruptedTurn", () => {
  it("treats the live manual-stop reason as authoritative", () => {
    expect(
      isInterruptedTurn(
        { status: "completed", stopReason: "end_turn" } as never,
        "cancelled",
      ),
    ).toBe(true);
  });

  it("uses persisted cancelled turn metadata", () => {
    expect(
      isInterruptedTurn(
        { status: "cancelled", stopReason: "end_turn" } as never,
        null,
      ),
    ).toBe(true);
    expect(
      isInterruptedTurn(
        { status: "completed", stopReason: "cancelled" } as never,
        null,
      ),
    ).toBe(true);
  });
});

describe("turnFooterStatusLabel", () => {
  it("prioritizes stopped-by-user over failure labels", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "cancelled" } as never,
        null,
        "AGENT RESPONSE FAILURE",
      ),
    ).toBe("STOPPED BY USER");
  });

  it("renders an active-turn failure label when the turn was not cancelled", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "end_turn" } as never,
        null,
        "AGENT RESPONSE FAILURE",
      ),
    ).toBe("AGENT RESPONSE FAILURE");
  });

  it("labels a persisted failed turn AGENT STOPPED when no live failure is shown", () => {
    // The mid-answer crash the duplicate-turn guard swallows: the row settled
    // "failed" but the session flipped back to ready with failure cleared.
    expect(
      turnFooterStatusLabel(
        { status: "failed", stopReason: null } as never,
        null,
        null,
      ),
    ).toBe("AGENT STOPPED");
  });

  it("prefers the specific live failure label over the generic AGENT STOPPED", () => {
    expect(
      turnFooterStatusLabel(
        { status: "failed", stopReason: null } as never,
        null,
        "AGENT EXITED",
      ),
    ).toBe("AGENT EXITED");
  });

  it("suppresses AGENT STOPPED while an auto-rebuild is retrying the turn", () => {
    expect(
      turnFooterStatusLabel(
        { status: "failed", stopReason: null } as never,
        null,
        null,
        true,
      ),
    ).toBe(null);
  });

  it("shows nothing for a completed turn", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "end_turn" } as never,
        null,
        null,
      ),
    ).toBe(null);
  });
});

// Named endings and the Continue gate.
import { continuableStopReason } from "../turn-footer";

describe("turnFooterStatusLabel named stop reasons", () => {
  it("names a token-cap truncation instead of rendering nothing", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "max_tokens" } as never,
        null,
        null,
      ),
    ).toBe("TOKEN LIMIT — ANSWER TRUNCATED");
  });

  it("names blocking-limit and prompt-too-long stops", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "blocking_limit" } as never,
        null,
        null,
      ),
    ).toBe("BLOCKED BY USAGE LIMIT");
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "prompt_too_long" } as never,
        null,
        null,
      ),
    ).toBe("PROMPT TOO LONG");
  });

  it("reads the live fallback stop reason before the turn row is fetched", () => {
    expect(turnFooterStatusLabel(null, "max_tokens", null)).toBe(
      "TOKEN LIMIT — ANSWER TRUNCATED",
    );
  });

  it("a named stop reason beats a generic failure label (the turn settled, it didn't fail)", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "max_tokens" } as never,
        null,
        "AGENT RESPONSE FAILURE",
      ),
    ).toBe("TOKEN LIMIT — ANSWER TRUNCATED");
  });

  it("budget stops get NO footer pill — the Turn-stopped card already names the ending", () => {
    expect(
      turnFooterStatusLabel(
        { status: "completed", stopReason: "budget_exhausted" } as never,
        null,
        null,
      ),
    ).toBeNull();
  });
});

describe("continuableStopReason — the Continue action gate", () => {
  it("offers Continue for the two recoverable stops only", () => {
    expect(
      continuableStopReason({ stopReason: "max_tokens" } as never, null),
    ).toBe("max_tokens");
    expect(
      continuableStopReason({ stopReason: "budget_exhausted" } as never, null),
    ).toBe("budget_exhausted");
    expect(
      continuableStopReason({ stopReason: "end_turn" } as never, null),
    ).toBeNull();
    expect(
      continuableStopReason({ stopReason: "cancelled" } as never, null),
    ).toBeNull();
    expect(
      continuableStopReason({ stopReason: "blocking_limit" } as never, null),
    ).toBeNull();
  });

  it("falls back to the live stop reason before the turn row lands", () => {
    expect(continuableStopReason(null, "max_tokens")).toBe("max_tokens");
  });
});

// A reopened chat rebuilds its whole transcript, so this footer is REMOUNTED on
// every chat-tab switch, workspace switch, and app reload. It used to start each
// of those from `useState(null)` and fetch, so a stopped turn rendered as an
// ordinary settled turn — no pill — until the bridge answered. The row is keyed
// server state now: the retained snapshot paints the truth on the first frame.
describe("turn footer first paint after a reopen", () => {
  const row = (over: Partial<TurnInfo> = {}): TurnInfo => ({
    chatId: "chat-1",
    turnId: "user-1",
    workspaceId: null,
    folder: null,
    agentId: "cursor",
    ord: 1,
    summary: "hi",
    startedAt: 1_000,
    endedAt: 2_000,
    stopReason: "cancelled",
    status: "cancelled",
    preSnapshot: null,
    postSnapshot: null,
    files: [],
    ...over,
  });

  const renderFooter = () =>
    renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          ActionsCtx.Provider,
          { value: {} as never },
          createElement(TurnFooter, {
            chatId: "chat-1",
            turnId: "user-1",
            events: [],
            startedAt: 1_000,
            live: false,
          }),
        ),
      ),
    );

  beforeEach(() => turnRowCache.clear());

  it("paints STOPPED BY USER from the retained row, with no fetch first", () => {
    turnRowCache.setData(turnRowKey("chat-1", "user-1"), row());
    expect(renderFooter()).toContain("STOPPED BY USER");
  });

  it("dates a stopped turn from the row, not from its (absent) events", () => {
    // The exact reported turn: stopped a second after sending, so it has no
    // events to date it and nothing but the row to explain it. The recorded
    // 1s must survive — the elapsed timer counting from the prompt is the
    // reload glitch, not the truth.
    turnRowCache.setData(
      turnRowKey("chat-1", "user-1"),
      row({ startedAt: 1_000, endedAt: 2_000 }),
    );
    const html = renderFooter();
    expect(html).toContain("STOPPED BY USER");
    expect(html).toContain("1s");
  });

  it("without a cached row there is nothing to paint — hence the cache", () => {
    expect(renderFooter()).not.toContain("STOPPED BY USER");
  });
});
