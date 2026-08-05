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

  it("keeps the retired design MCP absent and blocks coding-agent access", () => {
    expect(existsSync(resolve(root, "apps/desktop/src/engine/design/mcp-server.ts"))).toBe(
      false,
    );
    const engine = read("apps/desktop/src/engine/zeros-engine.ts");
    expect(engine).not.toContain("DesignMcpServer");
    expect(engine).not.toContain("ZEROS_DESIGN_MCP_TOKEN");
    expect(engine).not.toContain("setDesignServerResolver");
    expect(engine).toContain("assertAgentWorkspaceProcessStartAllowed");
    expect(engine).toContain("removeDesignAdditionalDirectories");
    expect(engine).toMatch(
      /assertAgentWorkspaceProcessStartAllowed\(\s*lifecycleWorkspaceId,\s*spawnOpts\.workspaceId,\s*spawnOpts\.cwd,?\s*\)/,
    );
    expect(engine).toMatch(
      /isDesignWorkspaceProcessTarget\(msg\.workspaceId\)[\s\S]{0,120}isDesignWorkspaceProcessTarget\(msg\.cwd\)/,
    );
    const listSessionsCase = engine.match(
      /case "AGENT_LIST_SESSIONS":([\s\S]*?)case "AGENT_LOAD_SESSION":/,
    )?.[1];
    expect(listSessionsCase).toContain("assertAgentWorkspaceNotDesign");
    expect(listSessionsCase).not.toContain(
      "assertAgentWorkspaceProcessStartAllowed",
    );
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
    expect(appShell).toContain("shouldLeaveBlockedDesignWorkspace({");
    expect(appShell).toContain(
      "useWorkspacePrSync(designWorkspaceRequested ? null : activeWorkspace)",
    );
    expect(appShell).toMatch(
      /worktreeMissing\s*&&\s*activeWorkspace\s*&&\s*!designWorkspaceBlocked/,
    );
    expect(appShell).not.toContain("designMode=");
  });

  it("gates design creation and discovery on the effective Internal feature", () => {
    const creation = read("apps/desktop/src/renderer/shell/create-workspace.ts");
    expect(creation).toContain('isInternalFeatureActive("designWorkspaces")');
    const archiveActions = read("apps/desktop/src/renderer/state/archive-actions.ts");
    expect(archiveActions).toContain(
      'isInternalFeatureActive("designWorkspaces")',
    );
    expect(archiveActions).toMatch(
      /mayPublishNavigation\s*=\s*restored\.kind !== "design"\s*\|\|\s*isInternalFeatureActive\("designWorkspaces"\)/,
    );
    expect(archiveActions).toContain(
      "if (mayPublishNavigation) opts?.onRestored?.(result)",
    );

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

    const settings = read("apps/desktop/src/renderer/features/settings/settings-page.tsx");
    expect(settings).toContain('useInternalFeature("designWorkspaces")');
    expect(settings).toContain('label="Design workspaces"');

    const addProject = read("apps/desktop/src/renderer/shell/add-project-provider.tsx");
    expect(addProject).toContain('isInternalFeatureActive("designWorkspaces")');
    const repositories = read("apps/desktop/src/renderer/features/repositories/repositories-panel.tsx");
    expect(repositories).toMatch(
      /workspaceList\(\{\s*repoSlug:\s*project\.repoSlug,\s*includeDesign:\s*true,?\s*\}\)/,
    );
  });
});
