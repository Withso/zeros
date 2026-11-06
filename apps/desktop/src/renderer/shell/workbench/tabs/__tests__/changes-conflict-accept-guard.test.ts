import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  write: vi.fn(),
  refresh: vi.fn(),
  activity: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/renderer/platform/files", () => ({
  readWorkspaceFile: vi.fn(),
  writeWorkspaceFile: mocks.write,
}));
vi.mock("@/renderer/platform/git", () => ({ gitDiff: vi.fn() }));
vi.mock("@/renderer/platform/turns", () => ({ turnDiff: vi.fn() }));
vi.mock("@/renderer/platform/skill-source", () => ({ readSkillSource: vi.fn() }));
vi.mock("@/renderer/shell/use-git-refresh-key", () => ({ triggerGitRefresh: mocks.refresh }));
vi.mock("@/renderer/state/workspace-store", () => ({ recordWorkspaceActivity: mocks.activity }));
vi.mock("@/renderer/shared/ui/primitives/elements", () => ({
  toast: { info: mocks.info, error: mocks.error },
}));

import { readWorkspaceFile } from "@/renderer/platform/files";
import {
  loadWorkspaceFileRead,
  peekWorkspaceFileRead,
  resetWorkspaceFileDataCacheForTests,
} from "../../../workspace-file-data-cache";
import { acceptCardConflict } from "../changes-conflict-accept";

const readFile = vi.mocked(readWorkspaceFile);
const path = "src/a.ts";
const shown = "top\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";
const edited = `${shown}// agent edit\n`;
const text = (content: string) => ({ kind: "text" as const, path, bytes: content.length, content });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // Reset, not clear: a queued one-off read must not leak into the next case.
  vi.resetAllMocks();
  resetWorkspaceFileDataCacheForTests();
  mocks.write.mockResolvedValue({ kind: "success", path, bytes: 1 });
});

describe.each([
  ["Local", "/work"],
  ["cloud", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"],
])("a Changes card accept in a %s workspace", (_placement, cwd) => {
  it("reads the file again instead of sharing a read that began before the click", async () => {
    // A background revalidation starts while the file still matches the card,
    // then an agent edits the file before the user clicks Accept.
    const earlier = deferred<ReturnType<typeof text>>();
    readFile.mockReturnValueOnce(earlier.promise).mockResolvedValueOnce(text(edited));
    const background = loadWorkspaceFileRead({ cwd, path });

    const accept = acceptCardConflict(cwd, path, shown, 0, "current");
    earlier.resolve(text(shown));
    await Promise.all([accept, background]);

    expect(readFile).toHaveBeenCalledTimes(2);
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalledWith("src/a.ts changed, so its conflicts were refreshed.");
    // The earlier response never replaces what the later read observed.
    expect(peekWorkspaceFileRead({ cwd, path })?.content).toBe(edited);
  });

  it("writes when the read made after the click still matches the card", async () => {
    readFile.mockResolvedValue(text(shown));
    await acceptCardConflict(cwd, path, shown, 0, "incoming");
    expect(mocks.write).toHaveBeenCalledWith(cwd, path, "top\ntheirs\n", { expectedContent: shown });
    expect(mocks.refresh).toHaveBeenCalledWith(cwd);
  });

  it("says why when that read fails, and writes nothing", async () => {
    readFile.mockResolvedValue({ kind: "error", path, bytes: 0, error: "Workspace is offline" });
    await acceptCardConflict(cwd, path, shown, 0, "current");
    expect(mocks.write).not.toHaveBeenCalled();
    expect(mocks.error).toHaveBeenCalledWith("Couldn't read src/a.ts", {
      description: "Workspace is offline",
    });
  });
});
