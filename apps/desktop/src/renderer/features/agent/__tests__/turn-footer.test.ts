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
  canPreviewTurnFileDiff,
  isInterruptedTurn,
  TurnFilePill,
  turnFooterFiles,
  turnFooterStatusLabel,
} from "../turn-footer";
import { TooltipProvider } from "@/renderer/shared/ui/primitives/tooltip";
import { pickStartedAt } from "../activity-hud";

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
