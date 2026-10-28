// Resolve a fixture's existing tab before driving the production workbench.
import { runNativeRendererAction, waitForNativeRenderer } from "./design-native-renderer.mjs";

/** A connected engine is not a hydrated renderer catalog. Recover the saved
 * Local fixture identities before a restart scenario's single navigation;
 * never substitute newly adopted worktrees for the rows under test. */
export async function prepareNativeWorkspaceCatalog(page, workspaces, timeout = 30_000) {
  await runNativeRendererAction(page, async workspaces => {
    const { loadProjects, syncProjectsToEngine } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { reloadWorkspacesFor } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    await syncProjectsToEngine();
    for (const { folder } of workspaces) {
      const project = loadProjects().find(project => project.repoRoot === folder);
      if (!project) throw new Error("Native fixture project did not hydrate.");
      await reloadWorkspacesFor(project.repoSlug);
    }
  }, workspaces);
  // Boot discovery can supersede that read while retaining provisional rows
  // in the visible union. Wait for exact-key confirmation, without repeating
  // synchronization, navigation, or workspace creation.
  await waitForNativeRenderer(page, async workspaces => {
    const { loadProjects } = await import("/apps/desktop/src/renderer/state/projects-store.ts");
    const { peekWorkspacesFor } = await import("/apps/desktop/src/renderer/state/use-projects.ts");
    return workspaces.every(({ folder, workspaceId }) => {
      const project = loadProjects().find(project => project.repoRoot === folder);
      return Boolean(project && peekWorkspacesFor(project.repoSlug)?.some(row => row.id === workspaceId && row.path === folder));
    });
  }, workspaces, timeout).catch(cause => {
    throw new Error("Exact native fixture workspace did not hydrate.", { cause });
  });
}

export function nativeWorkbenchTabId(scope, type) {
  const matches = scope.tabs.filter(tab => tab.type === type);
  const fixed = type === "files" ? matches.filter(tab => tab.fixed) : [];
  const candidates = fixed.length ? fixed : matches;
  if (candidates.length !== 1 || typeof candidates[0].id !== "string")
    throw new Error(`Expected one existing ${type} tab in the fixture workspace.`);
  return candidates[0].id;
}

export async function activateNativeWorkbenchTab(page, folder, type) {
  const scope = await page.evaluate(async folder => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const { defaultScopeFor } = await import("/apps/desktop/src/renderer/shell/workbench/tab-model.ts");
    return useWorkspaceStore.getState().workbenchByScope[folder] ?? defaultScopeFor(folder);
  }, folder);
  const id = nativeWorkbenchTabId(scope, type);
  await page.evaluate(async ({ folder, id, type }) => {
    const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
    const { defaultScopeFor } = await import("/apps/desktop/src/renderer/shell/workbench/tab-model.ts");
    const scope = useWorkspaceStore.getState().workbenchByScope[folder] ?? defaultScopeFor(folder);
    if (!scope.tabs.some(tab => tab.id === id && tab.type === type))
      throw new Error("Fixture tab changed before activation.");
    useWorkspaceStore.getState().dispatch({ type: "ACTIVATE_WORKBENCH_TAB", scope: folder, id });
    const active = useWorkspaceStore.getState().workbenchByScope[folder] ?? defaultScopeFor(folder);
    if (active.activeId !== id) throw new Error(`Fixture did not activate ${type}.`);
  }, { folder, id, type });
}
