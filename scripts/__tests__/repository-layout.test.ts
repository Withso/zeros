import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

// The Linux host prerequisites the contained-execution suites need. These used
// to be inline shell duplicated across preflight.yml's jobs, which is how the
// three release workflows came to be missing them entirely.
const CONTAINMENT_ACTION =
  ".github/actions/contained-execution-runtime/action.yml";

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
  it("runs the required actionlint check for every pull request", () => {
    const workflowLint = read(".github/workflows/lint-ci.yml");

    expect(workflowLint).toContain("  pull_request:");
    expect(workflowLint).not.toMatch(/\n  pull_request:\s*\n\s+paths:/);
  });

  it("runs the required CodeQL check for pull requests and merge queues", () => {
    const codeql = read(".github/workflows/codeql.yml");

    expect(codeql).toContain("  pull_request:");
    expect(codeql).toContain("  merge_group:");
    expect(codeql).toContain("    name: codeql");
  });

  it("keeps the reviewed WorkOS Gitleaks false positive exact", () => {
    const fingerprint =
      "8bf0f9e959046859c835fc2938b07e7c7afb7c7a:apps/desktop/electron/workos-desktop-client.ts:linkedin-client-id:30";
    const ignore = read(".gitleaksignore");
    const desktopClient = read(
      "apps/desktop/electron/workos-desktop-client.ts",
    );

    expect(ignore).toContain(fingerprint);
    expect(desktopClient).toContain(
      '"LinkedInOAuth", // gitleaks:allow — WorkOS authentication method name, not a client identifier',
    );
  });

  it("keeps required source-sync red until every ZSR architecture qualifies", () => {
    const preflight = read(".github/workflows/preflight.yml");

    expect(preflight).toContain("  source-sync-workload:");
    expect(preflight).toMatch(
      /  source-sync:\n(?:.|\n)*?    name: source-sync \(macOS\)\n(?:.|\n)*?    needs:\n(?:.|\n)*?      - source-sync-workload\n(?:.|\n)*?      - zsr-macos-intel\n(?:.|\n)*?      - zsr-linux-arm64/,
    );
    expect(preflight).toContain("SOURCE_SYNC_RESULT:");
    expect(preflight).toContain("ZSR_MACOS_INTEL_RESULT:");
    expect(preflight).toContain("ZSR_LINUX_ARM64_RESULT:");
  });

  it("uses the HTTPS Ubuntu archive before the amd64 containment install", () => {
    const action = read(CONTAINMENT_ACTION);
    const archive = action.indexOf("https://archive.ubuntu.com/ubuntu");
    const update = action.indexOf("sudo apt-get update");

    expect(archive).toBeGreaterThanOrEqual(0);
    expect(archive).toBeLessThan(update);
    // archive.ubuntu.com serves no arm64 packages — those live on
    // ports.ubuntu.com — so rewriting an arm64 runner's mirror list to it would
    // break `apt-get update` outright. The arm64 ZSR job used to avoid that
    // only by omitting the rewrite; one shared action makes the guard explicit.
    expect(action).toContain('[ "$(uname -m)" = "x86_64" ]');
  });

  it("smokes the production bubblewrap and seccomp namespace prerequisites", () => {
    const action = read(CONTAINMENT_ACTION);
    const usernsEnable = action.indexOf("with-userns.sh");
    const sandboxSmoke = action.indexOf("--ro-bind / /");

    expect(action).toContain("bubblewrap socat");
    expect(usernsEnable).toBeGreaterThanOrEqual(0);
    expect(usernsEnable).toBeLessThan(sandboxSmoke);
    expect(action).not.toContain("bwrap-userns-restrict");
    expect(action.slice(sandboxSmoke)).toContain("--unshare-user");
    expect(action.slice(sandboxSmoke)).toContain("--cap-drop ALL");
    expect(action.slice(sandboxSmoke)).toContain("--unshare-pid");
    expect(action.slice(sandboxSmoke)).toContain("--proc /proc");
    expect(action.slice(sandboxSmoke)).toContain('"$apply_seccomp" /bin/true');
  });

  it("keeps the userns relaxation scoped to one command and restores it", () => {
    // A job-wide relaxation would leave every later step — including
    // third-party actions — running with unprivileged user namespaces
    // permitted. This helper exists to keep that window one command wide.
    const helper = read("scripts/ci/with-userns.sh");

    expect(helper).toContain(
      "KEY=kernel.apparmor_restrict_unprivileged_userns",
    );
    expect(helper).toContain("trap restore EXIT");
    expect(helper).toContain('sudo sysctl -q -w "$KEY=$restriction"');
    expect(helper).toContain('sudo sysctl -q -w "$KEY=0"');
    // It must run the caller's command rather than a hard-coded suite, and it
    // must fail loudly rather than run that command still restricted.
    expect(helper).toMatch(/^"\$@"$/m);
    expect(helper).toContain('if [ "$applied" != "0" ]');
  });

  it("fails closed when an explicit containment test path disappears", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const command = rootPackage.scripts["check:design-containment"] ?? "";
    expect(command).toMatch(/^node scripts\/run-explicit-vitest\.mjs /);

    const files = command
      .split(/\s+/)
      .filter((token) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(token));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => !existsSync(file))).toEqual([]);
  });

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

  it("keeps the credential-free Codex smoke inside its throwaway state root", () => {
    const smoke = read("scripts/codex-app-server-smoke.mjs");

    // This command is routinely launched by a coding agent whose sandbox can
    // write the workspace/tmpdir but not the user's ~/.codex. The smoke claims
    // to need no credentials, so touching ambient Codex state is both needless
    // and enough to make the protocol check fail before initialize.
    expect(smoke).toContain("process.env.CODEX_HOME = codexHome");
    expect(smoke).toContain("fs.mkdirSync(codexHome, { recursive: true })");
  });

  it("keeps Electron main in sync during the default Conductor dev run", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      scripts: Record<string, string>;
    };
    const launcher = read("scripts/dev-instance.mjs");
    const supervisor = read("scripts/dev-main-supervisor.mjs");

    // Conductor's repository-local Dev action invokes `pnpm electron:dev`.
    // Renderer HMR without a matching main/preload restart creates a split
    // runtime where newly-rendered IPC calls fail as "unknown command".
    expect(rootPackage.scripts["electron:dev"]).toContain(
      "dev-instance.mjs --watch",
    );
    expect(launcher).toContain("useMainSupervisor");
    expect(supervisor).toContain('new Set(["main.cjs", "preload.cjs"])');
  });

  it("explains when an agent sandbox blocks the macOS engine smoke listener", () => {
    const smoke = read("scripts/smoke-engine.mjs");

    expect(smoke).toContain('error.code === "EPERM"');
    expect(smoke).toMatch(/local TCP listeners?.*sandbox/is);
    expect(smoke).toMatch(/grant.*network|outside.*sandbox/is);
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
    for (const app of ["control-plane", "web", "marketing"]) {
      expect(vite).toContain(`"**/apps/${app}/**"`);
    }
    expect(existsSync("apps/feedback-worker/package.json")).toBe(false);
    expect(existsSync("apps/control-plane/src/feedback.ts")).toBe(true);
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
      "@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.238",
      "@cursor/sdk-darwin-arm64@1.0.28",
      "@vscode/ripgrep-darwin-arm64@1.18.0",
      // The staged Codex runtime is redistributed inside Contents/Resources,
      // so its platform package must carry terms — not just the JS wrapper.
      // npm publishes it as an alias, hence the platform-suffixed version.
      "@openai/codex@0.149.0-darwin-arm64",
      "@tiptap/extension-bubble-menu@3.26.0",
      "@tiptap/extension-floating-menu@3.26.0",
      "@types/trusted-types@2.0.7",
      "@workos-inc/node@10.12.0",
    ]) {
      expect(licenses).toContain(packageName);
    }

    expect(licenses).not.toMatch(
      /@(?:anthropic-ai\/claude-agent-sdk|cursor\/sdk|vscode\/ripgrep)-linux-/,
    );
    expect(licenses).not.toContain("@openai/codex@0.149.0-linux-x64");
    expect(generator).not.toContain('"--no-optional"');
    expect(generator).toContain("runNpmLicenseInventory");
    expect(generator).toContain("web Pages functions");
  });

  it("stages the pinned Codex runtime instead of falling back to PATH", () => {
    const rootPackage = read("package.json");
    const beforePack = read("scripts/electron-before-pack.cjs");
    const packaging = read("electron-builder.yml");
    const sidecar = read("apps/desktop/electron/sidecar.ts");
    const packagingCheck = read("scripts/check-packaging-paths.mjs");

    expect(existsSync("scripts/stage-codex-cli.mjs")).toBe(true);
    expect(rootPackage).toContain('"stage:codex-cli"');
    expect(beforePack).toContain("stage-codex-cli.mjs");
    expect(packaging).toContain("from: binaries/codex-runtime");
    expect(packaging).toContain("from: binaries/codex-cli-version.txt");
    expect(sidecar).toContain("ZEROS_CODEX_CLI_PATH");
    expect(sidecar).toContain("ZEROS_CODEX_CLI_VERSION");
    expect(sidecar).toContain("CODEX_MANAGED_PACKAGE_ROOT");
    expect(packagingCheck).toContain("binaries/codex-runtime");
    expect(packagingCheck).toContain("binaries/codex-cli-version.txt");

    // A packaged build whose staging went missing must report NO bundled
    // version. The @openai/codex wrapper's package.json survives inside
    // app.asar even though its platform package is excluded, so a version
    // handed over without the binary it describes would have the provider list
    // advertise the pin while the adapter ran an unpinned `codex` from PATH.
    const compactSidecar = sidecar.replace(/\s+/g, "");
    expect(compactSidecar).toContain(
      "codexCli.binary&&!process.env.ZEROS_CODEX_CLI_PATH",
    );
    expect(compactSidecar).toContain(
      "codexCli.version&&!process.env.ZEROS_CODEX_CLI_VERSION",
    );

    // Staging the vendor target redistributes the platform package's native
    // binaries, so the license inventory has to normalize it into the packaged
    // macOS graph rather than record only the JS wrapper.
    expect(read("scripts/generate-third-party-licenses.mjs")).toContain(
      'packageName: "@openai/codex-darwin-arm64"',
    );
  });

  it("does not let an enclosing Zeros parent watchdog kill the engine smoke", () => {
    const engineSmoke = read("scripts/smoke-engine.mjs");

    expect(engineSmoke).toContain('ZEROS_PARENT_PID: ""');
    expect(engineSmoke).toContain('source: "browser"');
    expect(engineSmoke).not.toContain('source: "client"');
  });

  it("threads the active session's live model capabilities into the unified menu", () => {
    const composerPills = read(
      "apps/desktop/src/renderer/features/agent/composer-pills.tsx",
    );
    const modelMenu = read(
      "apps/desktop/src/renderer/features/agent/agent-model-menu.tsx",
    );

    expect(composerPills).toContain("initialize={initialize}");
    expect(modelMenu).toContain("initialize?: InitializeResponse | null");
    expect(modelMenu).toContain(
      "agent.id === value?.agentId ? initialize : null",
    );
  });

  it("keeps parse5's decoder available to the packaged Electron main process", () => {
    const rootPackage = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };

    expect(rootPackage.dependencies.parse5).toBe("^7.3.0");
    expect(rootPackage.dependencies.entities).toBe("^6.0.1");
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
    const launcher = read(
      "scripts/cloud-workspace-validation/sandbox/start-engine.sh",
    );
    const attester = read(
      "scripts/cloud-workspace-validation/sandbox/attest-cloud-worker.mjs",
    );
    const admission = read(
      "scripts/cloud-workspace-validation/sandbox/consume-cloud-admission.mjs",
    );
    const runtime = read("scripts/cloud-workspace-validation/runtime.ts");

    expect(config).toContain("mode: 0o700");
    expect(config).toContain("mode: 0o600");
    expect(config).toContain("fs.renameSync(temporary, stateFile)");
    expect(config).toContain('u.searchParams.delete("token")');
    expect(client).toContain('"zeros-v1"');
    expect(client).toContain("zeros-cloud-token.${Buffer.from");
    expect(client).toContain('source: "browser" as const');
    expect(client).not.toContain('source: "client"');
    expect(client).toContain('from "../../../packages/protocol/src/version"');
    expect(client).not.toMatch(/const PROTOCOL_VERSION\s*=\s*\d/);
    expect(lifecycle).toContain("clearState()");
    expect(dockerfile).toContain("&& pnpm rebuild better-sqlite3");
    expect(dockerfile).not.toContain("pnpm rebuild better-sqlite3 || true");
    expect(dockerfile).toContain(
      'if [ "${#ZEROS_REPO_COMMIT}" -ne 40 ] && [ "${#ZEROS_REPO_COMMIT}" -ne 64 ]',
    );
    expect(image).toContain("&& pnpm rebuild better-sqlite3`");
    expect(image).not.toContain("pnpm rebuild better-sqlite3 || true");
    expect(config).toContain('SANDBOX_ENGINE_DIR = "/opt/zeros"');
    expect(config).toContain('SANDBOX_REPO_DIR = "/workspace/zeros"');
    expect(config).toMatch(/node:22[^"\n]+@sha256:[a-f0-9]{64}/);
    expect(image).toContain("acl bubblewrap busybox-static ca-certificates");
    expect(image).toContain('"/etc/zeros/cloud-worker.json"');
    expect(dockerfile).toContain("bubblewrap");
    expect(dockerfile).toContain("podman");
    expect(image).toContain("podman");
    expect(dockerfile).toContain(
      "COPY sandbox/cloud-worker.json /etc/zeros/cloud-worker.json",
    );
    expect(dockerfile).toContain(
      "COPY sandbox/consume-cloud-admission.mjs /usr/local/lib/zeros/consume-cloud-admission.mjs",
    );
    expect(dockerfile).not.toContain("prepare-zsr-cgroups");
    expect(image).not.toContain("prepare-zsr-cgroups");
    expect(dockerfile).not.toMatch(/curl[^\n|]*\|\s*(?:ba)?sh/);
    expect(image).not.toMatch(/curl[^\n|]*\|\s*(?:ba)?sh/);
    expect(dockerfile).not.toMatch(/mutagen/i);
    expect(image).not.toMatch(/mutagen/i);
    expect(attester).toContain("cloud-worker-admission.json");
    expect(attester).toContain("rootControlledTree(ENGINE)");
    expect(admission).toContain("renameSync(PROOF, consumed)");
    expect(admission).toContain("containerInitStartTicks");
    expect(launcher).toContain("consume-cloud-admission.mjs");
    expect(runtime).toContain("attestCloudWorker(");
    expect(runtime).toContain("relaunchQualifiedCloudEngine");
    expect(lifecycle).toContain("relaunchQualifiedCloudEngine");
    expect(launcher).toContain(
      'node "$ENGINE_DIR/dist-engine/cli.js" serve --root "$REPO_DIR"',
    );
    expect(launcher).not.toContain('node "$REPO_DIR/dist-engine/cli.js"');
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
    expect(stable).toContain("Require a Beta-validated release branch");
    expect(stable).toContain(
      "Production must be dispatched from 'release/X.Y.Z' after Beta validation",
    );
    expect(stable).not.toContain("refs/heads/main|refs/heads/release/*");
  });
});
