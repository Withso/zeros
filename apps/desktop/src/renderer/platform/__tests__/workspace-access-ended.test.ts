import { beforeEach, expect, it, vi } from "vitest";
import { clearWorkspaceAccessEnded, registerAccessAccountScope, reportWorkspaceAccessEnded, resetWorkspaceAccessForTests, subscribeWorkspaceAccessEnded,
  workspaceAccessEnded, workspaceAccessScope } from "../team-sharing-registry";

const org = "99999999-9999-4999-8999-999999999999", other = "88888888-8888-4888-8888-888888888888";
const a = { organizationId: org, workspaceId: "11111111-1111-4111-8111-111111111111" }, b = { organizationId: org, workspaceId: "22222222-2222-4222-8222-222222222222" };
let account: { userId: string; generation: number } | null = { userId: "user-1", generation: 1 };
beforeEach(() => { resetWorkspaceAccessForTests(); account = { userId: "user-1", generation: 1 }; registerAccessAccountScope(() => account ? `${account.userId}#${account.generation}` : null); });

it("keeps one ended state per account, organization and workspace, notifies on each change only, and clears it", () => {
  const listener = vi.fn(), stop = subscribeWorkspaceAccessEnded(listener);
  reportWorkspaceAccessEnded(a); reportWorkspaceAccessEnded(a);
  expect(workspaceAccessEnded(a)).toBe(true); expect(workspaceAccessEnded(b)).toBe(false);
  expect(workspaceAccessEnded({ organizationId: other, workspaceId: a.workspaceId })).toBe(false);
  expect(listener).toHaveBeenCalledTimes(1);
  clearWorkspaceAccessEnded(a); clearWorkspaceAccessEnded(a);
  expect(workspaceAccessEnded(a)).toBe(false); expect(listener).toHaveBeenCalledTimes(2);
  stop();
});

it("D3: never shows another account's ended state on this Mac (A → B → A), and an account switch clears it", () => {
  reportWorkspaceAccessEnded(a);
  account = { userId: "creator", generation: 2 };   // switched to the workspace's Creator
  expect(workspaceAccessEnded(a)).toBe(false);
  account = { userId: "user-1", generation: 3 };    // and back: a new session must confirm it again
  expect(workspaceAccessEnded(a)).toBe(false);
  account = null;                                   // signed out: nothing is ever ended
  reportWorkspaceAccessEnded(a);
  expect(workspaceAccessEnded(a)).toBe(false);
});

it("D3: drops a late report that belongs to the account that was signed in when it started", () => {
  const started = workspaceAccessScope();
  account = { userId: "creator", generation: 2 };
  reportWorkspaceAccessEnded(a, started);
  expect(workspaceAccessEnded(a)).toBe(false);
});
