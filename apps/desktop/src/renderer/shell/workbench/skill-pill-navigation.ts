import type { SkillSource } from "../../platform/skill-source";
import { validSkillSource } from "../../platform/skill-source";
import { useWorkspaceStore } from "../../state/store";
import { workbenchScopeForFolder } from "../../state/workspace-store";
import { createFilesTab, defaultScopeFor } from "./tab-model";
import { loadWorkspaceFileRead } from "../workspace-file-data-cache";

export function warmSkillPill(cwd: string | null | undefined, source: SkillSource): void {
  if (!cwd || !validSkillSource(source)) return;
  void loadWorkspaceFileRead({ cwd, path: source.path, skillSource: source }, { maxAgeMs: 15_000 }).catch(() => {});
}

export function openSkillPill(cwd: string | null | undefined, source: SkillSource): void {
  if (!cwd || !validSkillSource(source)) return;
  const scope = workbenchScopeForFolder(cwd);
  const state = useWorkspaceStore.getState();
  const current = state.workbenchByScope[scope] ?? defaultScopeFor(scope);
  const existing = current.tabs.find(tab => tab.type === "files" && tab.skillSource?.agentId === source.agentId && tab.skillSource.path === source.path);
  if (existing) state.dispatch({ type: "ACTIVATE_WORKBENCH_TAB", id: existing.id, scope });
  else state.dispatch({ type: "ADD_WORKBENCH_TAB", scope, tab: {
    ...createFilesTab(source.path), skillSource: source, fileTreeVisible: false, title: source.name,
  } });
}
