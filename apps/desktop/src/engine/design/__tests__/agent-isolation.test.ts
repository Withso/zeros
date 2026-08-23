import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("design workspace agent isolation", () => {
  it("keeps design credentials and MCP registration out of coding-agent adapters", () => {
    const codingHarness = [
      "apps/desktop/src/engine/agents/gateway.ts",
      "apps/desktop/src/engine/agents/adapters/claude-sdk/adapter.ts",
      "apps/desktop/src/engine/agents/adapters/codex/app-server-adapter.ts",
      "apps/desktop/src/engine/agents/adapters/codex/app-server.ts",
      "apps/desktop/src/engine/agents/adapters/cursor-sdk/adapter.ts",
    ]
      .map(read)
      .join("\n");

    expect(codingHarness).not.toContain("zeros-design");
    expect(codingHarness).not.toContain("ZEROS_DESIGN_MCP_TOKEN");
    expect(codingHarness).not.toContain("ZEROS_CHAT_MODE");
  });

  it("keeps the retired design MCP absent and protects design files territorially", () => {
    expect(
      existsSync(resolve(root, "apps/desktop/src/engine/design/mcp-server.ts")),
    ).toBe(false);
    const engine = read("apps/desktop/src/engine/zeros-engine.ts");
    expect(engine).not.toContain("DesignMcpServer");
    expect(engine).not.toContain("ZEROS_DESIGN_MCP_TOKEN");
    expect(engine).not.toContain("setDesignServerResolver");
    expect(engine).toContain("assertAgentWorkspaceProcessStartAllowed");
    // Concurrent duality: agents and terminals run in every workspace
    // regardless of view mode — the retired workspace-level bans must not
    // creep back in. Code-agent containment is provider/OS enforced; the
    // actor-scoped provider boundary and serialized Git rewrite wrapper remain.
    expect(engine).not.toContain("assertAgentWorkspaceNotDesign");
    expect(engine).not.toContain("isDesignWorkspaceProcessTarget");
    expect(engine).not.toContain("removeDesignAdditionalDirectories");
    expect(engine).toContain("DESIGN_DIR_REWRITE_OPS");
    expect(engine).toContain("withDesignDirectoryWritable");
    expect(engine).toContain("reconcileDesignDirAfterExternalGit");
    const workspaceLock = read(
      "apps/desktop/src/engine/design/workspace-lock.ts",
    );
    expect(workspaceLock).not.toMatch(/(?:^|\W)fenceDesignDirFiles,/m);
    expect(workspaceLock).not.toMatch(/await\s+fenceDesignDirFiles\s*\(/);
    const productionSources = [
      "apps/desktop/src/engine/design/workspace-lock.ts",
      "apps/desktop/src/engine/git/design-mode.ts",
      "apps/desktop/src/engine/git/worktree.ts",
      "apps/desktop/src/engine/workspace/service.ts",
      "apps/desktop/src/engine/zeros-engine.ts",
    ]
      .map(read)
      .join("\n");
    expect(productionSources).not.toMatch(
      /\b(?:fenceDesignDirFiles|lockCodebase|withUnlocked)\s*\(/,
    );
    // Ordinary source saves must not trigger an O(Design tree) territory scan;
    // semantic authority is reconciled on settings and Git-ref changes, while
    // Design transactions stay in their own semantic mutation lane.
    expect(engine).not.toContain(
      'source: "settings" | "git-refs" | "worktree"',
    );
    const newSessionCase = engine.match(
      /case "AGENT_NEW_SESSION":([\s\S]*?)case "AGENT_PROMPT":/,
    )?.[1];
    expect(newSessionCase).toContain("assertAgentWorkspaceProcessStartAllowed");
    const listSessionsCase = engine.match(
      /case "AGENT_LIST_SESSIONS":([\s\S]*?)case "AGENT_FORK_CONVERSATION":/,
    )?.[1];
    // Listing durable provider metadata does not start an agent process and
    // must not reintroduce the retired view-mode ban.
    expect(listSessionsCase).not.toContain(
      "assertAgentWorkspaceProcessStartAllowed",
    );
    const forkConversationCase = engine.match(
      /case "AGENT_FORK_CONVERSATION":([\s\S]*?)case "AGENT_LOAD_SESSION":/,
    )?.[1];
    expect(forkConversationCase).toContain(
      "assertAgentWorkspaceProcessStartAllowed",
    );
    const loadSessionCase = engine.match(
      /case "AGENT_LOAD_SESSION":([\s\S]*?)default:/,
    )?.[1];
    expect(loadSessionCase).toContain(
      "assertAgentWorkspaceProcessStartAllowed",
    );
    expect(engine).not.toContain(
      "change.gitRefsChanged || change.worktreeChanged",
    );
    expect(engine).toContain("change.designRecognitionChanged");
    const service = read("apps/desktop/src/engine/workspace/service.ts");
    expect(service).toContain("assertNoDesignPathWrites");
  });

  it("renders design beside its own sidebar instead of inside coding chat", () => {
    const codingRenderer = [
      "apps/desktop/src/renderer/shell/conversation/conversation-pane.tsx",
      "apps/desktop/src/renderer/shell/conversation/pane-layout.tsx",
      "apps/desktop/src/renderer/features/agent/agent-chat.tsx",
      "apps/desktop/src/renderer/features/agent/turn-footer.tsx",
    ]
      .map(read)
      .join("\n");
    expect(codingRenderer).not.toMatch(
      /DesignWorkspace|designMode|useDesign|zeros-design/,
    );

    const appShell = read("apps/desktop/src/renderer/app-shell.tsx");
    expect(appShell).not.toContain(
      'useInternalFeatureActive("designWorkspaces")',
    );
    expect(appShell).toContain("<DesignWorkspaceSidebar");
    expect(appShell).toContain(
      'useNewTabHotkeys(activePage === "workspace" && !designWorkspaceRequested)',
    );
    // Design is a normal public presentation mode. It must not fall through
    // to coding chat or a rollout-disabled placeholder.
    expect(appShell).not.toContain("shouldShowBlockedDesignModePlaceholder");
    expect(appShell).not.toContain("DesignModeDisabledPanel");
    expect(appShell).not.toContain("designWorkspaceBlocked");
    expect(appShell).toContain(
      "useWorkspacePrSync(designWorkspaceRequested ? null : activeWorkspace)",
    );
    expect(appShell).toMatch(
      /worktreeMissing\s*&&\s*activeWorkspace\s*&&\s*activePage === "workspace"/,
    );
    expect(appShell).not.toContain("designMode=");
  });

  it("publishes Design to every desktop user while retaining local-runtime boundaries", () => {
    const creation = read(
      "apps/desktop/src/renderer/shell/create-workspace.ts",
    );
    expect(creation).not.toContain("isInternalFeatureActive");
    expect(creation).toContain("isNativeRuntime() || isExpectedElectron()");
    const archiveActions = read(
      "apps/desktop/src/renderer/state/archive-actions.ts",
    );
    // Restore and its navigation are never rollout-gated: a Design row is an
    // ordinary public workspace destination.
    expect(archiveActions).not.toContain("mayPublishNavigation");
    expect(archiveActions).toContain("opts?.onRestored?.(result)");
    expect(archiveActions).not.toContain("isInternalFeatureActive");

    const topBar = read("apps/desktop/src/renderer/shell/top-bar.tsx");
    expect(topBar).not.toContain(
      'useInternalFeatureActive("designWorkspaces")',
    );
    expect(topBar).not.toContain("activeFolderBlockedDesign");
    // The workspace-kind picker moved to the Create page; the top bar's "+"
    // is a route to it and carries no Design gate of its own.
    expect(topBar).not.toContain("designWorkspaceCreationAvailable");
    const createPage = read(
      "apps/desktop/src/renderer/shell/dispatcher/dispatcher-modal.tsx",
    );
    expect(createPage).not.toContain("isInternalFeatureActive");
    expect(createPage).toMatch(
      /designWorkspaceCreationAvailable\s*=\s*\n?\s*nativeRuntime\.ready\s*\|\|\s*nativeRuntime\.expectedElectron/,
    );
    expect(createPage).toContain('kind: "design"');
    expect(createPage).toContain("Create design workspace");

    const settings = read(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );
    expect(settings).not.toContain('useInternalFeature("designWorkspaces")');
    expect(settings).not.toContain('label="Design workspaces"');

    const addProject = read(
      "apps/desktop/src/renderer/shell/add-project-provider.tsx",
    );
    expect(addProject).not.toContain("isInternalFeatureActive");
    const contextMenu = read(
      "apps/desktop/src/renderer/shared/ui/workspace-context-menu.tsx",
    );
    expect(contextMenu).not.toContain("designModeSwitchAvailable");
    expect(contextMenu).toContain(
      "const showModeSwitch = !isLocalMainWorkspace(workspace)",
    );
    const repositories = read(
      "apps/desktop/src/renderer/features/repositories/repositories-panel.tsx",
    );
    expect(repositories).toMatch(
      /workspaceList\(\{\s*repoSlug:\s*project\.repoSlug,\s*includeDesign:\s*true,?\s*\}\)/,
    );
  });

  it("keeps every Design product surface independent of Internal feature flags", () => {
    const publicDesignSurfaces = [
      "apps/desktop/src/renderer/app-shell.tsx",
      "apps/desktop/src/renderer/shell/top-bar.tsx",
      "apps/desktop/src/renderer/shell/home-sidebar.tsx",
      "apps/desktop/src/renderer/shell/create-workspace.ts",
      "apps/desktop/src/renderer/shell/add-project-provider.tsx",
      "apps/desktop/src/renderer/features/dashboard/dashboard-page.tsx",
      "apps/desktop/src/renderer/features/repositories/repo-page.tsx",
      "apps/desktop/src/renderer/state/archive-actions.ts",
      "apps/desktop/src/renderer/state/use-open-workspace.ts",
      "apps/desktop/src/renderer/shared/ui/workspace-context-menu.tsx",
    ]
      .map(read)
      .join("\n");
    const internalFeatures = read(
      "apps/desktop/src/renderer/features/settings/internal-features.ts",
    );
    const settings = read(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );

    expect(publicDesignSurfaces).not.toContain("designWorkspaces");
    expect(internalFeatures).not.toContain('"designWorkspaces"');
    expect(settings).not.toContain('label="Design workspaces"');
  });
});
