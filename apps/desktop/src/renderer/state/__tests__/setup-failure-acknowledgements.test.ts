import { beforeEach, describe, expect, it } from "vitest";

import {
  SETUP_FAILURE_ACKNOWLEDGED_LIMIT,
  acknowledgeSetupFailure,
  forgetSetupFailureAcknowledgement,
  reconcileSetupFailureAcknowledgements,
  resetSetupFailureAcknowledgementsForTests,
  setupFailureAcknowledged,
  setupFailureShown,
} from "../setup-failure-acknowledgements";

const STORAGE_KEY = "zeros-setup-failure-acknowledged-v1";
let values: Map<string, string>;

beforeEach(() => {
  values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
  resetSetupFailureAcknowledgementsForTests();
});

const failed = (id: string) => ({ id, setupState: "failed" as const });

describe("setup failure acknowledgements", () => {
  it("shows a failure until it is acknowledged", () => {
    expect(setupFailureShown(failed("a"), setupFailureAcknowledged("a"))).toBe(true);
    acknowledgeSetupFailure("a");
    expect(setupFailureShown(failed("a"), setupFailureAcknowledged("a"))).toBe(false);
    expect(setupFailureShown({ id: "b", setupState: "passed" }, false)).toBe(false);
  });

  it("survives a relaunch, bounded and validated", () => {
    acknowledgeSetupFailure("a");
    expect(JSON.parse(values.get(STORAGE_KEY)!)).toEqual(["a"]);
    values.set(STORAGE_KEY, JSON.stringify(["", 3, "kept", ...Array.from({ length: SETUP_FAILURE_ACKNOWLEDGED_LIMIT }, (_, i) => `w${i}`)]));
    resetSetupFailureAcknowledgementsForTests();
    expect(setupFailureAcknowledged("kept")).toBe(false);
    expect(setupFailureAcknowledged(`w${SETUP_FAILURE_ACKNOWLEDGED_LIMIT - 1}`)).toBe(true);
  });

  it("acknowledges a failure once an agent works or another status replaces it", () => {
    reconcileSetupFailureAcknowledgements([failed("a"), failed("b")], (id) => id === "a");
    expect(setupFailureAcknowledged("a")).toBe(true);
    expect(setupFailureAcknowledged("b")).toBe(false);
  });

  it("forgets the acknowledgement when setup leaves failed, so the next failure shows", () => {
    acknowledgeSetupFailure("a");
    reconcileSetupFailureAcknowledgements([{ id: "a", setupState: "running" }], () => false);
    expect(setupFailureAcknowledged("a")).toBe(false);
    reconcileSetupFailureAcknowledgements([failed("a")], () => false);
    expect(setupFailureShown(failed("a"), setupFailureAcknowledged("a"))).toBe(true);
    acknowledgeSetupFailure("a");
    forgetSetupFailureAcknowledgement("a");
    expect(setupFailureAcknowledged("a")).toBe(false);
  });

  it("writes nothing when nothing changes", () => {
    reconcileSetupFailureAcknowledgements([failed("a")], () => false);
    expect(values.has(STORAGE_KEY)).toBe(false);
  });
});
