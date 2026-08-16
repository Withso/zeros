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
    expect(appShell).toContain('useInternalFeatureActive("designWorkspaces")');
    expect(appShell).toContain("<DesignWorkspaceSidebar");
    expect(appShell).toContain("useNewTabHotkeys(!designWorkspaceRequested)");
    // Mode model: a blocked design route mounts the placeholder (with its
    // never-gated "exit design mode" action) instead of bouncing Home — and
    // the coding harness must still never mount as a fallback for it.
    expect(appShell).toContain("shouldShowBlockedDesignModePlaceholder({");
    expect(appShell).toContain("<DesignModeDisabledPanel");
    expect(appShell).toContain(
      "useWorkspacePrSync(designWorkspaceRequested ? null : activeWorkspace)",
    );
    expect(appShell).toMatch(
      /worktreeMissing\s*&&\s*activeWorkspace\s*&&\s*!designWorkspaceBlocked/,
    );
    expect(appShell).not.toContain("designMode=");
  });

  it("gates design creation on the Internal feature while modes stay reachable", () => {
    const creation = read(
      "apps/desktop/src/renderer/shell/create-workspace.ts",
    );
    expect(creation).toContain('isInternalFeatureActive("designWorkspaces")');
    const archiveActions = read(
      "apps/desktop/src/renderer/state/archive-actions.ts",
    );
    // Mode model: restore and its navigation are NEVER design-gated — a
    // design-mode row must stay reachable (the blocked route renders the
    // placeholder with its un-gated exit), so the old mayPublishNavigation
    // gate must not creep back in.
    expect(archiveActions).not.toContain("mayPublishNavigation");
    expect(archiveActions).toContain("opts?.onRestored?.(result)");

    const topBar = read("apps/desktop/src/renderer/shell/top-bar.tsx");
    expect(topBar).toContain('useInternalFeatureActive("designWorkspaces")');
    expect(topBar).toMatch(
      /designWorkspacesInternalActive\s*&&\s*\(nativeRuntime\.ready\s*\|\|\s*nativeRuntime\.expectedElectron\)/,
    );
    expect(topBar).toContain("if (activeFolderBlockedDesign) return;");
    expect(topBar).toMatch(/\{designWorkspacesActive \? \(\s*<DropdownMenu>/);
    expect(topBar).toContain(
      'onClick={() => void handleCreateWorkspace("code")}',
    );

    const settings = read(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );
    expect(settings).toContain('useInternalFeature("designWorkspaces")');
    expect(settings).toContain('label="Design workspaces"');

    const addProject = read(
      "apps/desktop/src/renderer/shell/add-project-provider.tsx",
    );
    expect(addProject).toContain('isInternalFeatureActive("designWorkspaces")');
    const repositories = read(
      "apps/desktop/src/renderer/features/repositories/repositories-panel.tsx",
    );
    expect(repositories).toMatch(
      /workspaceList\(\{\s*repoSlug:\s*project\.repoSlug,\s*includeDesign:\s*true,?\s*\}\)/,
    );
  });
});
