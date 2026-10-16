import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPUTER_USE_SERVICE_VERSION,
  computerUseWaitText,
  type ComputerUseStateSnapshot,
} from "@zeros/protocol/computer-use-tools";

import {
  clearComputerUseState,
  computerUseStateSnapshot,
  publishComputerUseState,
} from "../computer-use-state-store";

function snapshot(
  holders: ComputerUseStateSnapshot["holders"],
  waiting: ComputerUseStateSnapshot["waiting"],
): ComputerUseStateSnapshot {
  return { version: COMPUTER_USE_SERVICE_VERSION, holders, waiting };
}

beforeEach(() => {
  clearComputerUseState();
});

describe("computer use state mirror", () => {
  it("keeps the latest valid snapshot and ignores malformed events", () => {
    expect(computerUseStateSnapshot()).toBeNull();
    const state = snapshot(
      [
        {
          workspaceId: "workspace-a",
          conversationId: "conversation-a",
          agent: "codex",
          app: "Safari",
          native: false,
        },
      ],
      [
        {
          workspaceId: "workspace-a",
          conversationId: "conversation-b",
          agent: "claude",
        },
      ],
    );
    expect(publishComputerUseState(state)).toBe(true);
    // The validated copy is a fresh object, so snapshots stay immutable.
    expect(computerUseStateSnapshot()).toEqual(state);
    expect(publishComputerUseState({ version: 99 })).toBe(false);
    expect(publishComputerUseState(null)).toBe(false);
    expect(computerUseStateSnapshot()).toEqual(state);

    clearComputerUseState();
    expect(computerUseStateSnapshot()).toBeNull();
  });

  it("tells a waiting chat which computer use it queues behind", () => {
    publishComputerUseState(
      snapshot(
        [
          {
            workspaceId: "workspace-a",
            conversationId: "conversation-a",
            agent: "codex",
            app: null,
            native: true,
          },
        ],
        [
          {
            workspaceId: "workspace-a",
            conversationId: "conversation-b",
            agent: "claude",
          },
        ],
      ),
    );
    const state = computerUseStateSnapshot();
    expect(computerUseWaitText(state, "conversation-b")).toBe(
      "Waiting for Codex in another chat to finish using the computer",
    );
    expect(computerUseWaitText(state, "conversation-a")).toBeNull();
    expect(computerUseWaitText(null, "conversation-b")).toBeNull();
  });
});
