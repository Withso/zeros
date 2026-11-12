import { expect, it, vi } from "vitest";
import { clearWorkspaceAccessEnded, reportWorkspaceAccessEnded, resetWorkspaceAccessForTests, subscribeWorkspaceAccessEnded, workspaceAccessEnded } from "../team-sharing-registry";

it("keeps one ended state per workspace, notifies on each change only, and clears it", () => {
  resetWorkspaceAccessForTests();
  const listener = vi.fn(), stop = subscribeWorkspaceAccessEnded(listener);
  const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
  reportWorkspaceAccessEnded(a); reportWorkspaceAccessEnded(a);
  expect(workspaceAccessEnded(a)).toBe(true); expect(workspaceAccessEnded(b)).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  clearWorkspaceAccessEnded(a); clearWorkspaceAccessEnded(a);
  expect(workspaceAccessEnded(a)).toBe(false); expect(listener).toHaveBeenCalledTimes(2);
  stop();
});
