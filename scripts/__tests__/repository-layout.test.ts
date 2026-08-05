import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("repository layout contracts", () => {
  it("keeps active automation off retired repository roots", () => {
    expect(existsSync("backend")).toBe(false);
    expect(existsSync("website")).toBe(false);

    const preflight = read(".github/workflows/preflight.yml");
    expect(preflight).not.toMatch(/working-directory:\s*backend(?:\/|\s|$)/);
    expect(preflight).toContain("working-directory: apps/control-plane");
    expect(preflight).toContain("'apps/desktop/src/'");

    const schemas = read("scripts/build-settings-schemas.ts");
    expect(schemas).toContain('"apps", "marketing", "public", "schemas"');
    expect(schemas).not.toContain('"website", "marketing"');

    const changelog = read("scripts/changelog-new.mjs");
    expect(changelog).not.toContain('"website"');
    expect(changelog).toContain('"apps"');

    const marketingInstall = read("apps/web/scripts/cf-install-marketing.mjs");
    expect(marketingInstall).toContain('"apps", "marketing"');
    expect(marketingInstall).not.toContain('"website", "marketing"');

    const workspaceSetup = read(".conductor/settings.toml");
    expect(workspaceSetup).toContain("pnpm install --frozen-lockfile");
    expect(workspaceSetup).toContain(
      "pnpm --dir apps/control-plane install --frozen-lockfile",
    );
    expect(workspaceSetup).toContain("npm --prefix apps/web ci");
    expect(workspaceSetup).not.toContain("pnpm --dir backend install");

    expect(preflight).toContain("npm --prefix apps/web ci");
    expect(preflight).toContain("npm --prefix apps/web run typecheck");
    expect(preflight).toContain("npm --prefix apps/web run build:standalone");
    expect(preflight).not.toContain("npm --prefix apps/web run build\n");
    expect(preflight).toContain("github-connection-model.test.ts");
    expect(preflight).not.toContain("github-section-helpers.test.ts");
  });

  it("keeps direct Electron compiler output at the root build boundary", () => {
    const electron = JSON.parse(
      read("apps/desktop/electron/tsconfig.json"),
    ) as {
      compilerOptions: { outDir: string };
      exclude: string[];
    };

    expect(electron.compilerOptions.outDir).toBe("../../../dist-electron");
    expect(electron.exclude).toContain("../../../node_modules");
    expect(electron.exclude).toContain("../../../dist-electron");
  });

  it("keeps substantial implementations in semantically named files", () => {
    const contracts = [
      {
        barrel: "apps/desktop/src/engine/index.ts",
        implementation: "apps/desktop/src/engine/zeros-engine.ts",
        exportPath: 'from "./zeros-engine"',
      },
      {
        barrel: "apps/desktop/src/engine/db/index.ts",
        implementation: "apps/desktop/src/engine/db/database.ts",
        exportPath: 'from "./database"',
      },
      {
        barrel: "apps/desktop/electron/ipc/commands/index.ts",
        implementation:
          "apps/desktop/electron/ipc/commands/command-registry.ts",
        exportPath: 'from "./command-registry"',
      },
      {
        barrel:
          "apps/desktop/src/renderer/shell/workbench/tabs/code-editor/index.ts",
        implementation:
          "apps/desktop/src/renderer/shell/workbench/tabs/code-editor/code-editor.tsx",
        exportPath: 'from "./code-editor"',
      },
    ];

    for (const contract of contracts) {
      expect(existsSync(contract.implementation)).toBe(true);
      expect(read(contract.barrel)).toContain(contract.exportPath);
      expect(read(contract.barrel).split("\n").length).toBeLessThan(20);
    }

    expect(
      existsSync(
        "apps/desktop/src/renderer/shell/workbench/tabs/code-editor/index.tsx",
      ),
    ).toBe(false);

    const workbenchTabs = read(
      "apps/desktop/src/renderer/shell/workbench/tab-strip.tsx",
    );
    expect(workbenchTabs).toContain("data-workbench-tab");
    expect(workbenchTabs).not.toContain("data-column3-tab");
  });

  it("keeps root-run tests out of standalone deployable typecheck graphs", () => {
    const marketing = JSON.parse(read("apps/marketing/tsconfig.app.json")) as {
      exclude?: string[];
    };

    expect(marketing.exclude).toContain("src/**/__tests__/**");
  });

  it("keeps feature ownership out of shared renderer primitives", () => {
    const sharedRoot = "apps/desktop/src/renderer/shared";
    const allowedReverseDependencies = new Set([
      "ui/primitives/code-textarea.tsx",
    ]);
    const violations = sourceFiles(sharedRoot).flatMap((path) => {
      const source = read(path);
      const importsProductLayer =
        /from\s+["'](?:@\/renderer\/|(?:\.\.\/)+)(?:features|shell)\//.test(
          source,
        );
      const name = relative(sharedRoot, path);
      return importsProductLayer && !allowedReverseDependencies.has(name)
        ? [name]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it("keeps Settings-owned type scaling with the Settings feature", () => {
    const globals = read("styles/globals.css");
    const settingsPage = read(
      "apps/desktop/src/renderer/features/settings/settings-page.tsx",
    );
    const settingsStyles = read(
      "apps/desktop/src/renderer/features/settings/settings-page.css",
    );

    expect(globals).not.toContain("global/settings.css");
    expect(existsSync("styles/global/settings.css")).toBe(false);
    expect(settingsPage).toContain('import "./settings-page.css";');
    expect(settingsStyles).toContain(".settings-type-scale .text-sm");
  });

  it("watches desktop source while ignoring sibling deployables", () => {
    const vite = read("vite.config.ts");
    expect(vite).not.toContain('"**/apps/**"');
    expect(vite).not.toContain('"**/website/**"');
    for (const app of [
      "control-plane",
      "web",
      "marketing",
      "feedback-worker",
    ]) {
      expect(vite).toContain(`"**/apps/${app}/**"`);
    }
  });

  it("keeps localhost discovery aligned with current development apps", () => {
    const marketingVite = read("apps/marketing/vite.config.ts");
    const desktopVite = read("vite.config.ts");
    const localhostDiscovery = read(
      "apps/desktop/electron/ipc/commands/localhost.ts",
    );
    const webPackage = read("apps/web/package.json");

    expect(marketingVite).toContain("port: 3000");
    expect(marketingVite).not.toContain("accounts");
    expect(desktopVite).not.toContain("3000-3002");
    expect(localhostDiscovery).not.toContain("Zeros accounts");
    expect(localhostDiscovery).toContain("port: 8788");
    expect(localhostDiscovery).toContain("Zeros web hub");
    expect(webPackage).toContain("--port 8788");

    const webAssembly = read("apps/web/scripts/assemble-marketing.mjs");
    expect(webAssembly).toContain("--standalone-install");
    expect(webAssembly).not.toContain(
      'path.join(REPO_ROOT, "node_modules", ".bin", "vite")',
    );
  });

  it("keeps development harness entries with their renderer code", () => {
    for (const name of [
      "context-canvas",
      "design-workspace",
      "diff-preview",
      "github-settings",
      "model-menu",
    ]) {
      expect(existsSync(`harness-${name}.html`)).toBe(false);
      expect(
        existsSync(`apps/desktop/src/renderer/harnesses/harness-${name}.html`),
      ).toBe(true);
    }

    const smoke = read("scripts/ui-smoke-composer.mjs");
    expect(smoke).toContain("/apps/desktop/src/renderer/harnesses");
    expect(smoke).not.toMatch(/127\.0\.0\.1:\$\{port\}\/harness-[a-z-]+\.html/);
  });

  it("uses owned UI terminology and records vendored component licenses", () => {
    const compatibilityButton = read(
      "apps/desktop/src/renderer/shared/ui/button.tsx",
    );
    const uiGuard = read("scripts/check-ui-consistency.mjs");
    const notices = read("THIRD-PARTY-NOTICES.md");
    const packaging = read("electron-builder.yml");
    const marketingLogos = read("apps/marketing/src/components/AgentLogos.tsx");

    expect(compatibilityButton).not.toMatch(/\bV0(?:Button|Variant|Size)/);
    expect(uiGuard).not.toContain("--v0-brand");
    expect(notices).toContain("AI Elements");
    expect(existsSync("third_party/ai-elements/LICENSE")).toBe(true);
    expect(existsSync("third_party/shadcn-ui/LICENSE")).toBe(true);
    expect(existsSync("third_party/lobe-icons/LICENSE")).toBe(true);
    expect(existsSync("third_party/README.md")).toBe(true);
    expect(existsSync("apps/marketing/public/agents/README.md")).toBe(true);
    expect(notices).toContain("Cursor's brand guidance");
    expect(marketingLogos).not.toContain("<svg");
    expect(packaging).toContain("from: third_party");
  });

  it("records the optional native packages that enter macOS releases", () => {
    const licenses = read("THIRD-PARTY-LICENSES.txt");
    const generator = read("scripts/generate-third-party-licenses.mjs");

    for (const packageName of [
      "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.221",
      "@cursor/sdk-darwin-arm64@1.0.26",
      "@vscode/ripgrep-darwin-arm64@1.18.0",
      "@tiptap/extension-bubble-menu@3.26.0",
      "@tiptap/extension-floating-menu@3.26.0",
      "@types/trusted-types@2.0.7",
    ]) {
      expect(licenses).toContain(packageName);
    }

    expect(licenses).not.toMatch(
      /@(?:anthropic-ai\/claude-agent-sdk|cursor\/sdk|vscode\/ripgrep)-linux-/,
    );
    expect(licenses).not.toContain("@openai/codex@0.146.0-linux-x64");
    expect(generator).not.toContain('"--no-optional"');
    expect(generator).toContain("apps/web gained production dependencies");
  });

  it("licenses the standalone marketing graph and publishes its notices", () => {
    const licenses = read("THIRD-PARTY-LICENSES.txt");
    const generator = read("scripts/generate-third-party-licenses.mjs");
    const rootPackage = read("package.json");
    const webAssembly = read("apps/web/scripts/assemble-marketing.mjs");

    for (const packageName of [
      "@types/estree@1.0.9",
      "@types/hast@3.0.5",
      "@types/react@18.3.31",
      "@ungap/structured-clone@1.3.3",
      "property-information@7.2.0",
    ]) {
      expect(licenses).toContain(packageName);
    }

    expect(generator).toContain("marketing standalone deployment");
    expect(generator).toContain("standalone: true");
    expect(rootPackage).toContain("prepare-third-party-license-graphs.mjs");
    for (const name of [
      "LICENSE.txt",
      "THIRD-PARTY-NOTICES.md",
      "THIRD-PARTY-LICENSES.txt",
    ]) {
      expect(webAssembly).toContain(name);
    }
  });

  it("keeps cloud validation isolated, private, and fail-closed", () => {
    expect(existsSync("scripts/cloud-spike")).toBe(false);
    expect(existsSync("scripts/cloud-workspace-validation/README.md")).toBe(
      true,
    );

    const config = read("scripts/cloud-workspace-validation/config.ts");
    const client = read(
      "scripts/cloud-workspace-validation/lib/bridge-client.ts",
    );
    const image = read("scripts/cloud-workspace-validation/image.ts");
    const lifecycle = read("scripts/cloud-workspace-validation/lifecycle.ts");
    const dockerfile = read("scripts/cloud-workspace-validation/Dockerfile");

    expect(config).toContain("mode: 0o700");
    expect(config).toContain("mode: 0o600");
    expect(config).toContain("fs.renameSync(temporary, stateFile)");
    expect(config).toContain('u.searchParams.delete("token")');
    expect(client).toContain('headers["x-zeros-cloud-token"]');
    expect(client).toContain('from "../../../packages/protocol/src/version"');
    expect(client).not.toMatch(/const PROTOCOL_VERSION\s*=\s*\d/);
    expect(lifecycle).toContain("clearState()");
    expect(dockerfile).toContain("&& pnpm rebuild better-sqlite3");
    expect(dockerfile).not.toContain("pnpm rebuild better-sqlite3 || true");
    expect(image).toContain("&& pnpm rebuild better-sqlite3`");
    expect(image).not.toContain("pnpm rebuild better-sqlite3 || true");
  });

  it("keeps private delivery ledgers out of tracked design references", () => {
    expect(
      existsSync(
        "styles/Artifacts/Designs/design-open-tasks-consolidated-2026-07-30.html",
      ),
    ).toBe(false);
  });

  it("keeps the active agent capability roadmap indexed and current", () => {
    const roadmapPath =
      "docs/agent-capabilities-parity-and-ui-consolidated-2026-07-01.md";
    const roadmap = read(roadmapPath);
    const docsIndex = read("docs/README.md");

    expect(existsSync(roadmapPath)).toBe(true);
    expect(docsIndex).toContain(
      "agent-capabilities-parity-and-ui-consolidated-2026-07-01.md",
    );
    expect(roadmap).toContain("actively maintained agent-capability backlog");
    expect(roadmap).toContain("packages/protocol/src/agent-events.ts");
    expect(roadmap).toContain(
      "apps/desktop/src/renderer/features/agent/sessions-store.ts",
    );
    expect(roadmap).not.toContain("packages/core/");
    expect(roadmap).not.toContain("`src/zeros/");
    expect(roadmap).not.toContain("design-open-tasks-consolidated");
  });

  it("keeps cloud workspace guidance current without restoring research dumps", () => {
    const cloudDocs = "docs/cloud-workspace";
    const expected = [
      "README.md",
      "architecture.md",
      "data-and-sync.md",
      "engineering-reference.md",
      "enterprise-and-self-hosting.md",
      "implementation-roadmap.md",
      "infrastructure-and-operations.md",
      "product-contract.md",
      "security.md",
    ];

    expect(readdirSync(cloudDocs).sort()).toEqual(expected);
    expect(read(`${cloudDocs}/README.md`)).toContain(
      "Cloud workspaces are **pre-production**",
    );
    expect(read(`${cloudDocs}/implementation-roadmap.md`)).toContain(
      "scripts/cloud-workspace-validation/",
    );
    expect(read(`${cloudDocs}/engineering-reference.md`)).toContain(
      "apps/desktop/src/engine/transport/cloud.ts",
    );
    expect(existsSync(`${cloudDocs}/02-how-conductor-does-it.md`)).toBe(false);
    expect(existsSync(`${cloudDocs}/research`)).toBe(false);
  });

  it("keeps public runtime requirements and deployment identifiers explicit", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      engines: { node: string };
    };
    const webPackage = JSON.parse(read("apps/web/package.json")) as {
      engines: { node: string };
    };
    const readme = read("README.md");
    const deployCheck = read("scripts/check-web-deploy.mjs");

    expect(rootPackage.engines.node).toBe(">=22.18.0");
    expect(webPackage.engines.node).toBe(">=22.18.0");
    expect(readme).toContain("Node.js 22.18 or newer");
    expect(deployCheck).toContain("process.env.CLOUDFLARE_ACCOUNT_ID");
    expect(deployCheck).not.toMatch(
      /CLOUDFLARE_ACCOUNT_ID\s*\|\|\s*["'][a-f\d]{16,}["']/i,
    );
  });

  it("limits release credentials to protected channel environments", () => {
    const alpha = read(".github/workflows/release-alpha.yml");
    const beta = read(".github/workflows/release-beta.yml");
    const stable = read(".github/workflows/release.yml");

    expect(alpha).toContain("environment: alpha");
    expect(beta).toContain("environment: beta");
    expect(alpha).not.toContain("workflow_dispatch:");
    expect(beta).not.toContain("workflow_dispatch:");
    expect(stable.match(/environment: production/g)).toHaveLength(2);
  });
});
