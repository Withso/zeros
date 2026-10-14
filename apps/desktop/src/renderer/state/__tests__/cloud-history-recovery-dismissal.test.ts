import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cloudWorkspaceKey } from "../../platform/bridge/cloud-workspace-key";
import { cloudHistoryRecoveryDismissed, dismissCloudHistoryRecovery, forgetCloudHistoryRecoveryDismissals } from "../cloud-history-recovery-dismissal";
const folder = () => cloudWorkspaceKey({ organizationId: randomUUID(), workspaceId: randomUUID() });
beforeEach(() => {
  const stored = new Map<string, string>();
  Object.assign(globalThis, { localStorage: { getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value), removeItem: (key: string) => stored.delete(key) } });
});
describe("exact history-recovery dismissal", () => {
  it("retains A-B-A dismissal only for its exact workspace and receipt and prunes confirmed deletion", () => {
    const a = folder(), b = folder(), receipt = randomUUID(), next = randomUUID();
    dismissCloudHistoryRecovery(a, receipt);
    expect(cloudHistoryRecoveryDismissed(a, receipt)).toBe(true);
    expect(cloudHistoryRecoveryDismissed(b, receipt)).toBe(false);
    expect(cloudHistoryRecoveryDismissed(a, next)).toBe(false);
    dismissCloudHistoryRecovery(b, receipt);
    expect(cloudHistoryRecoveryDismissed(a, receipt)).toBe(true);
    forgetCloudHistoryRecoveryDismissals([a]);
    expect(cloudHistoryRecoveryDismissed(a, receipt)).toBe(false);
    expect(cloudHistoryRecoveryDismissed(b, receipt)).toBe(true);
  });
  it("validates bounded local storage and never retains local paths or invalid receipts", () => {
    const first = folder(), receipt = randomUUID();
    localStorage.setItem("zeros-cloud-history-recovery-dismissed-v1", JSON.stringify([null, 3, "bad", [first, receipt], [first, receipt], ["/local", receipt]]));
    expect(cloudHistoryRecoveryDismissed(first, receipt)).toBe(true);
    dismissCloudHistoryRecovery("/local", receipt); dismissCloudHistoryRecovery(first, "invalid");
    for (let i = 0; i < 130; i++) dismissCloudHistoryRecovery(folder(), receipt);
    const saved = JSON.parse(localStorage.getItem("zeros-cloud-history-recovery-dismissed-v1")!);
    expect(saved).toHaveLength(128); expect(saved.some((row: string[]) => row[0] === "/local")).toBe(false);
    expect(cloudHistoryRecoveryDismissed(first, receipt)).toBe(false);
  });
});
