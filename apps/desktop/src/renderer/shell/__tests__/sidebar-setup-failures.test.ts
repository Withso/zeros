import { beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeSetupFailure,
  resetSetupFailureAcknowledgementsForTests,
  setupFailureAcknowledged,
} from "../../state/setup-failure-acknowledgements";
import { NO_SIGNAL, observeSidebarSetupFailures, type SidebarWorkspaceSignal } from "../sidebar-view-model";

beforeEach(() => {
  const values = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
  resetSetupFailureAcknowledgementsForTests();
});

const observing = (signals: Record<string, Partial<SidebarWorkspaceSignal>> = {}) => ({
  signalOf: (id: string) => ({ ...NO_SIGNAL, ...signals[id] }),
  chatIdsOf: () => ["chat"],
});

describe("observing setup failures from the sidebar", () => {
  // Setup can rerun from the Setup tab while the sidebar is collapsed. The
  // rerun's "running" state must still retire the old acknowledgement, or the
  // new failure stays hidden when the sidebar comes back.
  it("retires an acknowledgement while the sidebar is hidden", () => {
    const seen = new Map<string, string>();
    acknowledgeSetupFailure("a");
    observeSidebarSetupFailures({ workspaces: [{ id: "a", setupState: "running" }], seen, observing: null });
    expect(setupFailureAcknowledged("a")).toBe(false);
    observeSidebarSetupFailures({ workspaces: [{ id: "a", setupState: "failed" }], seen, observing: null });
    expect(setupFailureAcknowledged("a")).toBe(false);
  });

  it("only lets chat signals answer a failure while the sidebar is shown", () => {
    const seen = new Map<string, string>();
    const failed = [{ id: "a", setupState: "failed" as const }];
    observeSidebarSetupFailures({ workspaces: failed, seen, observing: observing() });
    observeSidebarSetupFailures({ workspaces: failed, seen, observing: null });
    // Hidden: nothing is observed, and the next shown pass starts fresh.
    observeSidebarSetupFailures({ workspaces: failed, seen, observing: observing({ a: { working: true } }) });
    expect(setupFailureAcknowledged("a")).toBe(false);
    observeSidebarSetupFailures({ workspaces: failed, seen, observing: observing({ a: { working: true, unread: true } }) });
    expect(setupFailureAcknowledged("a")).toBe(true);
  });
});
