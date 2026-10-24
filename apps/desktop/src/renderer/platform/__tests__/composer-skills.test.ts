import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), request: vi.fn(), status: "ready", bridge: { executionIdentity: { kind: "cloud" } } }));
vi.mock("../runtime", () => ({ isNativeRuntime: () => true, isElectron: () => true, runtimeName: () => "electron", nativeInvoke: mocks.invoke, nativeListen: vi.fn() }));
vi.mock("../bridge/active-bridge", () => ({ getActiveBridge: () => mocks.bridge }));
vi.mock("../bridge/workspace-bridge", () => ({ workspaceOp: mocks.request }));
vi.mock("../../state/cloud-workspace-catalog", () => ({ canBackgroundSyncCloudWorkspace: () => ["ready", "busy"].includes(mocks.status) }));
import { listSkills } from "../app";

beforeEach(() => { vi.clearAllMocks(); mocks.status = "ready"; mocks.invoke.mockResolvedValue([]); mocks.request.mockResolvedValue({ skills: [] }); });

it("reads cloud skills only from the exact VM and never invokes the Mac library", async () => {
  const cwd = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  await listSkills(cwd, "claude");
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledWith(mocks.bridge, "skills.list", { workspaceId: cwd, cwd, agentId: "claude" });
});

it.each(["/local/repo", "/organization/repo"])("keeps %s skill discovery on the native device", async cwd => {
  await listSkills(cwd, "claude");
  expect(mocks.invoke).toHaveBeenCalledWith("skills_list", { cwd, agentId: "claude" });
  expect(mocks.request).not.toHaveBeenCalled();
});

it("keeps cloud discovery on its workspace root for a nested chat cwd", async () => {
  const root = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
  await listSkills(`${root}/src`, "codex");
  expect(mocks.request).toHaveBeenCalledWith(mocks.bridge, "skills.list", { workspaceId: root, cwd: root, agentId: "codex" });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([null, {}, { skills: null }, [null]])("rejects a malformed native catalog without publishing it: %j", async response => {
  mocks.invoke.mockResolvedValue(response);
  await expect(listSkills("/local/repo", "claude")).rejects.toThrow(/skill/i);
});

it("does not turn a transient failure into an authoritative empty catalog", async () => {
  mocks.invoke.mockRejectedValue(new Error("unavailable"));
  await expect(listSkills("/local/repo", "claude")).rejects.toThrow("unavailable");
});

it("never falls back to Local for an old or unavailable cloud worker", async () => {
  mocks.request.mockRejectedValue(new Error("unsupported"));
  await expect(listSkills("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "claude")).rejects.toThrow("unsupported");
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each(["provisioning", "setting_up", "waking", "stopping", "stopped", "failed", "archived", "deleting", "deleted"])("does not send skill discovery to a %s cloud workspace", async status => {
  mocks.status = status;
  await expect(listSkills("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", "claude")).rejects.toThrow(/running/);
  expect(mocks.request).not.toHaveBeenCalled();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
