import { describe, expect, it } from "vitest";

import {
  classifyPrStatusEffectTrigger,
  effectivePrPollState,
  isTerminalPrState,
  PR_STATUS_FULL_POLL_MS,
  PR_STATUS_RESUME_MIN_AGE_MS,
  shouldPollPrStatus,
  shouldReconcileWorkspacePrState,
  shouldRefreshPrStatusOnResume,
  type PrStatusPollTrigger,
} from "../pr-status-refresh";

describe("classifyPrStatusEffectTrigger", () => {
  it("treats every retained active rising edge as an activation", () => {
    const first = classifyPrStatusEffectTrigger(null, true, "workspace#42");
    expect(first.trigger).toBe("activation");

    const hidden = classifyPrStatusEffectTrigger(
      first.activeDataKey,
      false,
      "workspace#42",
    );
    expect(hidden.activeDataKey).toBeNull();
    expect(hidden.trigger).toBeNull();

    const restored = classifyPrStatusEffectTrigger(
      hidden.activeDataKey,
      true,
      "workspace#42",
    );
    expect(restored.trigger).toBe("activation");
  });

  it("classifies same-key reruns while continuously active as refresh-key work", () => {
    const rerun = classifyPrStatusEffectTrigger(
      "workspace#42",
      true,
      "workspace#42",
    );
    expect(rerun).toEqual({
      activeDataKey: "workspace#42",
      trigger: "refresh-key",
    });
  });
});

describe("shouldRefreshPrStatusOnResume", () => {
  it("refreshes an unseen PR immediately", () => {
    expect(shouldRefreshPrStatusOnResume(0, 1)).toBe(true);
  });

  it("coalesces focus/visibility thrash, then refreshes promptly", () => {
    expect(
      shouldRefreshPrStatusOnResume(
        10_000,
        10_000 + PR_STATUS_RESUME_MIN_AGE_MS - 1,
      ),
    ).toBe(false);
    expect(
      shouldRefreshPrStatusOnResume(
        10_000,
        10_000 + PR_STATUS_RESUME_MIN_AGE_MS,
      ),
    ).toBe(true);
  });

  it("keeps the external GitHub poll bounded to one minute", () => {
    expect(PR_STATUS_FULL_POLL_MS).toBe(60_000);
  });
});

describe("shouldReconcileWorkspacePrState", () => {
  it("reconciles external draft/ready/closed/merged transitions only", () => {
    expect(shouldReconcileWorkspacePrState("draft", "ready")).toBe(true);
    expect(shouldReconcileWorkspacePrState("ready", "merged")).toBe(true);
    expect(shouldReconcileWorkspacePrState("closed", "closed")).toBe(false);
  });
});

const ALL_TRIGGERS: readonly PrStatusPollTrigger[] = [
  "interval",
  "resume",
  "refresh-key",
  "activation",
  "manual",
];

describe("isTerminalPrState", () => {
  it("treats only merged/closed as terminal", () => {
    expect(isTerminalPrState("merged")).toBe(true);
    expect(isTerminalPrState("closed")).toBe(true);
    expect(isTerminalPrState("ready")).toBe(false);
    expect(isTerminalPrState("draft")).toBe(false);
    expect(isTerminalPrState(null)).toBe(false);
    expect(isTerminalPrState(undefined)).toBe(false);
  });
});

describe("effectivePrPollState", () => {
  it("prefers live GitHub state over the persisted workspace row", () => {
    expect(
      effectivePrPollState({ state: "ready", mergedAt: null }, "merged"),
    ).toBe("ready");
  });

  it("treats a non-null mergedAt as merged even while `state` lags", () => {
    expect(effectivePrPollState({ state: "ready", mergedAt: 123 }, null)).toBe(
      "merged",
    );
  });

  it("falls back to the persisted row before the first settled fetch", () => {
    expect(effectivePrPollState(null, "closed")).toBe("closed");
    expect(effectivePrPollState(undefined, "merged")).toBe("merged");
    expect(effectivePrPollState(null, null)).toBeNull();
    expect(effectivePrPollState(null)).toBeNull();
  });
});

describe("shouldPollPrStatus", () => {
  it("always polls open/draft/unknown PRs on every trigger", () => {
    for (const trigger of ALL_TRIGGERS) {
      expect(shouldPollPrStatus("ready", trigger)).toBe(true);
      expect(shouldPollPrStatus("draft", trigger)).toBe(true);
      expect(shouldPollPrStatus(null, trigger)).toBe(true);
    }
  });

  it("suppresses every recurring trigger for merged/closed PRs", () => {
    for (const state of ["merged", "closed"]) {
      expect(shouldPollPrStatus(state, "interval")).toBe(false);
      expect(shouldPollPrStatus(state, "resume")).toBe(false);
      expect(shouldPollPrStatus(state, "refresh-key")).toBe(false);
    }
  });

  it("keeps terminal PRs re-checkable on user action (a PR can be reopened)", () => {
    expect(shouldPollPrStatus("merged", "activation")).toBe(true);
    expect(shouldPollPrStatus("closed", "activation")).toBe(true);
    expect(shouldPollPrStatus("merged", "manual")).toBe(true);
    expect(shouldPollPrStatus("closed", "manual")).toBe(true);
  });
});
