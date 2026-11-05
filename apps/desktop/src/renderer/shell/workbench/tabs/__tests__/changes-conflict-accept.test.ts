import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  refresh: vi.fn(),
  activity: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../../workspace-file-data-cache", () => ({ loadWorkspaceFileRead: mocks.read }));
vi.mock("@/renderer/platform/files", () => ({ writeWorkspaceFile: mocks.write }));
vi.mock("@/renderer/shell/use-git-refresh-key", () => ({ triggerGitRefresh: mocks.refresh }));
vi.mock("@/renderer/state/workspace-store", () => ({ recordWorkspaceActivity: mocks.activity }));
vi.mock("@/renderer/shared/ui/primitives/elements", () => ({
  toast: { info: mocks.info, error: mocks.error },
}));

import { acceptCardConflict } from "../changes-conflict-accept";

const cwd = "/work";
const path = "src/a.ts";
const shown =
  "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nmid\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> topic\n";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ kind: "text", path, content: shown, bytes: shown.length });
  mocks.write.mockResolvedValue({ kind: "success", path, bytes: 1 });
});

describe("accepting a conflict from a Changes card", () => {
  it("rewrites only that block through the ordinary file write, then refreshes", async () => {
    await acceptCardConflict(cwd, path, shown, 1, "both");
    expect(mocks.read).toHaveBeenCalledWith({ cwd, path }, { force: true });
    expect(mocks.write).toHaveBeenCalledWith(
      cwd,
      path,
      "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\nmid\nx\ny\n",
    );
    expect(mocks.activity).toHaveBeenCalledWith(cwd);
    expect(mocks.refresh).toHaveBeenCalledWith(cwd);
  });

  it("refreshes instead of writing when the file changed since the card was drawn", async () => {
    mocks.read.mockResolvedValue({ kind: "text", path, content: `${shown}// agent edit\n`, bytes: 1 });
    await acceptCardConflict(cwd, path, shown, 0, "incoming");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith("src/a.ts changed, so its conflicts were refreshed.");
    expect(mocks.refresh).toHaveBeenCalledWith(cwd);
  });

  it("keeps the card when the write is refused and says why", async () => {
    mocks.write.mockResolvedValue({ kind: "error", path, bytes: 0, error: "Design paths are read-only here" });
    await acceptCardConflict(cwd, path, shown, 0, "current");
    expect(mocks.error).toHaveBeenCalledWith("Couldn't save src/a.ts", {
      description: "Design paths are read-only here",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does nothing for a block that is no longer there", async () => {
    await acceptCardConflict(cwd, path, shown, 5, "current");
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });
});
