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
});
