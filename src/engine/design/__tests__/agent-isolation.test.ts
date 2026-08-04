import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("design workspace agent isolation", () => {
  it("keeps design credentials and MCP registration out of coding-agent adapters", () => {
    const codingHarness = [
      "src/engine/agents/gateway.ts",
      "src/engine/agents/adapters/claude-sdk/adapter.ts",
      "src/engine/agents/adapters/codex/app-server-adapter.ts",
      "src/engine/agents/adapters/codex/app-server.ts",
      "src/engine/agents/adapters/cursor-sdk/adapter.ts",
    ]
      .map(read)
      .join("\n");

    expect(codingHarness).not.toContain("zeros-design");
    expect(codingHarness).not.toContain("ZEROS_DESIGN_MCP_TOKEN");
    expect(codingHarness).not.toContain("ZEROS_CHAT_MODE");
  });

  it("keeps the retired design MCP absent and blocks coding-agent access", () => {
    expect(
      existsSync(resolve(root, "src/engine/design/mcp-server.ts")),
    ).toBe(false);
    const engine = read("src/engine/index.ts");
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
    expect(engine).toMatch(
      /case "AGENT_LIST_SESSIONS":[\s\S]{0,600}assertAgentWorkspaceProcessStartAllowed/,
    );
  });

  it("renders design beside its own sidebar instead of inside coding chat", () => {
    const codingRenderer = [
      "src/shell/column2-workspace.tsx",
      "src/shell/column2-panes.tsx",
      "src/zeros/agent/agent-chat.tsx",
      "src/zeros/agent/turn-footer.tsx",
    ]
      .map(read)
      .join("\n");
    expect(codingRenderer).not.toMatch(
      /DesignWorkspace|designMode|useDesign|zeros-design/,
    );

    const appShell = read("src/app-shell.tsx");
    expect(appShell).toContain(
      'useInternalFeatureActive("designWorkspaces")',
    );
    expect(appShell).toContain("<DesignWorkspaceSidebar");
    expect(appShell).toContain("useNewTabHotkeys(!designWorkspaceRequested)");
    expect(appShell).toContain(
      "shouldLeaveBlockedDesignWorkspace({",
    );
    expect(appShell).toContain(
      "useWorkspacePrSync(designWorkspaceRequested ? null : activeWorkspace)",
    );
    expect(appShell).toMatch(
      /worktreeMissing\s*&&\s*activeWorkspace\s*&&\s*!designWorkspaceBlocked/,
    );
    expect(appShell).not.toContain("designMode=");
  });

  it("gates design creation and discovery on the effective Internal feature", () => {
    const creation = read("src/shell/create-workspace.ts");
    expect(creation).toContain(
      'isInternalFeatureActive("designWorkspaces")',
    );
    const archiveActions = read("src/zeros/store/archive-actions.ts");
    expect(archiveActions).toContain(
      'isInternalFeatureActive("designWorkspaces")',
    );
    expect(archiveActions).toMatch(
      /mayPublishNavigation\s*=\s*restored\.kind !== "design"\s*\|\|\s*isInternalFeatureActive\("designWorkspaces"\)/,
    );
    expect(archiveActions).toContain(
      "if (mayPublishNavigation) opts?.onRestored?.(result)",
    );

    const topBar = read("src/shell/top-bar.tsx");
    expect(topBar).toContain(
      'useInternalFeatureActive("designWorkspaces")',
    );
    expect(topBar).toMatch(
      /designWorkspacesInternalActive\s*&&\s*\(nativeRuntime\.ready\s*\|\|\s*nativeRuntime\.expectedElectron\)/,
    );
    expect(topBar).toContain("if (activeFolderBlockedDesign) return;");
    expect(topBar).toMatch(
      /\{designWorkspacesActive \? \(\s*<DropdownMenu>/,
    );
    expect(topBar).toContain(
      'onClick={() => void handleCreateWorkspace("code")}',
    );

    const settings = read("src/zeros/panels/settings-page.tsx");
    expect(settings).toContain('useInternalFeature("designWorkspaces")');
    expect(settings).toContain('label="Design workspaces"');

    const addProject = read("src/shell/add-project-provider.tsx");
    expect(addProject).toContain(
      'isInternalFeatureActive("designWorkspaces")',
    );
    const repositories = read("src/zeros/panels/repositories-panel.tsx");
    expect(repositories).toMatch(
      /workspaceList\(\{\s*repoSlug:\s*project\.repoSlug,\s*includeDesign:\s*true,?\s*\}\)/,
    );
  });
});
