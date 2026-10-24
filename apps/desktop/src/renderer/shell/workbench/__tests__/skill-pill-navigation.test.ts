import { afterEach, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "@/renderer/state/store";
import * as fileData from "../../workspace-file-data-cache";
import { openSkillPill, warmSkillPill } from "../skill-pill-navigation";
import { createFilesTab } from "../tab-model";

const source = { agentId: "claude" as const, path: "/library/review/SKILL.md", name: "Review" };
const owners = ["/personal/repo", "/organization/repo", "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222"];
afterEach(() => vi.restoreAllMocks());

it.each(owners)("opens a source synchronously in its own %s scope without replacing a file draft", cwd => {
  const draft = createFilesTab("src/draft.ts");
  const dispatch = vi.fn();
  const read = vi.spyOn(fileData, "loadWorkspaceFileRead").mockResolvedValue({ kind: "text", path: source.path, bytes: 0, content: "" });
  vi.spyOn(useWorkspaceStore, "getState").mockReturnValue({ ...useWorkspaceStore.getState(), dispatch,
    workbenchByScope: { [cwd]: { tabs: [draft], activeId: draft.id, recentBrowsers: [] } },
  });
  openSkillPill(cwd, source);
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "ADD_WORKBENCH_TAB", scope: cwd, tab: expect.objectContaining({ skillSource: source, title: source.name, fileTreeVisible: false }) }));
  expect(draft.filePath).toBe("src/draft.ts");
  expect(read).not.toHaveBeenCalled();
  warmSkillPill(cwd, source);
  expect(read).toHaveBeenCalledWith({ cwd, path: source.path, skillSource: source }, { maxAgeMs: 15_000 });
});

it("deduplicates only an exact provider/source in the destination owner", () => {
  const cwd = owners[0];
  const tab = { ...createFilesTab(source.path), skillSource: source };
  const dispatch = vi.fn();
  vi.spyOn(useWorkspaceStore, "getState").mockReturnValue({ ...useWorkspaceStore.getState(), dispatch,
    workbenchByScope: { [cwd]: { tabs: [tab], activeId: tab.id, recentBrowsers: [] } },
  });
  openSkillPill(cwd, source);
  expect(dispatch).toHaveBeenLastCalledWith({ type: "ACTIVATE_WORKBENCH_TAB", id: tab.id, scope: cwd });
  openSkillPill(cwd, { ...source, agentId: "codex" });
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "ADD_WORKBENCH_TAB", scope: cwd }));
  openSkillPill(owners[1], source);
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ type: "ADD_WORKBENCH_TAB", scope: owners[1] }));
});
