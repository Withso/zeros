import { describe, expect, it } from "vitest";

import type { ExecutionBoundaryStatus } from "@zeros/protocol/containment";

import {
  boundaryGitCopy,
  boundaryStatusLabel,
  boundaryStatusRows,
} from "../boundary-status";

const readyStatus: ExecutionBoundaryStatus = {
  version: 1,
  actor: "agent-code",
  state: "ready",
  backend: "zeros-srt",
  designProtection: {
    required: true,
    enforced: true,
    protectedDirectoryCount: 1,
    territoryGeneration: "opaque-generation",
  },
  parity: { level: "full", restrictions: [] },
  services: {
    state: "ready",
    activeCount: 2,
    kinds: ["database", "gpg-agent"],
  },
  git: {
    state: "promoted",
    updatedRefs: 1,
    indexUpdated: true,
    changedAt: 12,
  },
  checkedAt: 12,
};

describe("boundary status UI copy", () => {
  it("explains the active uniform runtime and redacted mapped capabilities", () => {
    expect(boundaryStatusLabel(readyStatus)).toBe("Sandbox ready");
    expect(boundaryStatusRows(readyStatus)).toEqual([
      { label: "Runtime", value: "Zeros Sandbox Runtime" },
      { label: "Design", value: "Protected (1 directory)" },
      { label: "Workspace parity", value: "Full" },
      { label: "Mapped services", value: "2 (Database, GPG agent)" },
      { label: "Private Git", value: "Promoted (1 ref, index)" },
    ]);
    expect(JSON.stringify(boundaryStatusRows(readyStatus))).not.toMatch(
      /opaque-generation|[/\\]|token|socket|policy/i,
    );
  });

  it("names a territory restart and a blocked Git promotion without raw errors", () => {
    const restarting: ExecutionBoundaryStatus = {
      ...readyStatus,
      state: "draining",
      lifecycle: {
        lastTransition: "territory-restart",
        transitionedAt: 20,
      },
      git: {
        state: "blocked",
        issue: "promotion-conflict",
        changedAt: 19,
      },
    };

    expect(boundaryStatusLabel(restarting)).toBe(
      "Restarting for Design protection",
    );
    expect(boundaryGitCopy(restarting.git)).toBe(
      "Blocked by a concurrent Git or Design-impact conflict",
    );
  });

  it("does not label a restricted ready boundary as full parity", () => {
    const restricted: ExecutionBoundaryStatus = {
      ...readyStatus,
      parity: {
        level: "restricted",
        restrictions: ["container-workflows-unavailable"],
      },
      remediation: "Install the qualified private container worker.",
    };
    expect(boundaryStatusLabel(restricted)).toBe(
      "Sandbox ready — limited parity",
    );
    expect(boundaryStatusRows(restricted)).toContainEqual({
      label: "Workspace parity",
      value: "Restricted",
    });
  });
});
