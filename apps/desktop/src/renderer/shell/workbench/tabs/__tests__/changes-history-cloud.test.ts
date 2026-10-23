import { beforeEach, describe, expect, it, vi } from "vitest";

const turns = vi.hoisted(() => ({ list: vi.fn(async () => []) }));
vi.mock("@/renderer/platform/turns", () => ({ turnsList: turns.list }));
vi.mock("@/renderer/platform/git", () => ({ gitLog: vi.fn(async () => []) }));
import { loadChangesTurns } from "../changes-history-list";

beforeEach(() => turns.list.mockClear());
describe("Changes turn history placement", () => {
  it("reads turn history for a Local workspace", async () => {
    await loadChangesTurns("/Users/me/project");
    expect(turns.list).toHaveBeenCalledOnce();
  });
  it("lists no turns for a cloud workspace, whose worker serves no turn records yet", async () => {
    await expect(loadChangesTurns("cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).resolves.toEqual([]);
    expect(turns.list).not.toHaveBeenCalled();
  });
  // The cloud Changes tab showed "Couldn't load changes." beside a loaded diff:
  // its workspace id arrives as a scoped native resource, which the folder-key
  // test missed, and the worker refuses turns.list as CLOUD_V2_UNSUPPORTED.
  it("recognizes every cloud identity, not only the folder key", async () => {
    await expect(loadChangesTurns("cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:workspace")).resolves.toEqual([]);
    await expect(loadChangesTurns("22222222-2222-4222-8222-222222222222", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222")).resolves.toEqual([]);
    expect(turns.list).not.toHaveBeenCalled();
  });
  it("treats a cloud worker's unsupported turn history as empty, and keeps every other failure", async () => {
    turns.list.mockRejectedValueOnce(Object.assign(new Error("This operation is not available in cloud workspaces yet."), { code: "CLOUD_V2_UNSUPPORTED" }));
    await expect(loadChangesTurns("workspace-from-an-unrecognized-cloud-shape")).resolves.toEqual([]);
    turns.list.mockRejectedValueOnce(Object.assign(new Error("The Git command could not be completed."), { code: "GIT_COMMAND_FAILED" }));
    await expect(loadChangesTurns("/Users/me/project")).rejects.toThrow("could not be completed");
  });
});
