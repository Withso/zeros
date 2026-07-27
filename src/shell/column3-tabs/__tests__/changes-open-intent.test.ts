import { describe, expect, it } from "vitest";

import type { TurnInfo } from "@/native/turns";
import type { ChangedFile } from "../changes-parse";
import { changeAdvanceIntent, changeOpenIntent } from "../changes-open-intent";

function file(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: "src/a.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "",
    binary: false,
    staged: false,
    ...overrides,
  };
}

const TURN: TurnInfo = {
  chatId: "chat-1",
  turnId: "turn-1",
  summary: "do things",
  startedAt: 0,
  files: [],
} as unknown as TurnInfo;

describe("changeOpenIntent", () => {
  it("routes to the turn's authored diff while a turn filter is active", () => {
    expect(changeOpenIntent({ kind: "all" }, TURN, file())).toEqual({
      diff: true,
      diffScope: "turn",
      turnChatId: "chat-1",
      turnId: "turn-1",
    });
  });

  it("offers Discard only for All changes on a file with uncommitted work", () => {
    expect(
      changeOpenIntent({ kind: "all" }, null, file({ committed: false })),
    ).toMatchObject({ diffScope: "all", discardable: true });
    // Fully committed → nothing to discard.
    expect(
      changeOpenIntent({ kind: "all" }, null, file({ committed: true })),
    ).toMatchObject({ discardable: false });
    // committed undefined (e.g. a bare row) → not discardable.
    expect(changeOpenIntent({ kind: "all" }, null, file())).toMatchObject({
      discardable: false,
    });
    // Other scopes never discard, even with uncommitted work.
    expect(
      changeOpenIntent(
        { kind: "uncommitted" },
        null,
        file({ committed: false }),
      ),
    ).toMatchObject({ diffScope: "uncommitted", discardable: false });
    expect(
      changeOpenIntent({ kind: "staged" }, null, file({ committed: false })),
    ).toMatchObject({ diffScope: "staged", discardable: false });
    expect(
      changeOpenIntent({ kind: "unstaged" }, null, file({ committed: false })),
    ).toMatchObject({ diffScope: "unstaged", discardable: false });
  });

  it("carries the commit SHA for a single-commit scope", () => {
    expect(
      changeOpenIntent(
        { kind: "commit", sha: "abc123", message: "m" },
        null,
        file(),
      ),
    ).toEqual({
      diff: true,
      diffScope: "commit",
      diffSha: "abc123",
      discardable: false,
      isNewFile: false,
    });
  });

  it("flags live-status new files", () => {
    expect(
      changeOpenIntent({ kind: "all" }, null, file({ isNewFile: true })),
    ).toMatchObject({ isNewFile: true });
  });
});

describe("changeAdvanceIntent", () => {
  it("preserves the commit SHA while advancing to another path", () => {
    expect(
      changeAdvanceIntent({ diffScope: "commit", diffSha: "abc123" }),
    ).toEqual({ diff: true, diffScope: "commit", diffSha: "abc123" });
  });

  it("preserves the complete turn identity while advancing", () => {
    expect(
      changeAdvanceIntent({
        diffScope: "turn",
        turnChatId: "chat-1",
        turnId: "turn-1",
      }),
    ).toEqual({
      diff: true,
      diffScope: "turn",
      turnChatId: "chat-1",
      turnId: "turn-1",
    });
  });
});
