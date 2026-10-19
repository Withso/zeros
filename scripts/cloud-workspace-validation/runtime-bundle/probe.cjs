// Executed only after archive verification, under the bundled Node in a mount
// namespace that contains the runtime and OS libraries, with networking off.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

async function main() {
const root = process.argv[2];
const phase = process.argv[3];
assert(["engine", "cursor"].includes(phase));
const worker = path.join(root, "worker");
const node = path.join(root, "bin/node");
const fromWorker = createRequire(path.join(worker, "package.json"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8"),
);
fs.mkdirSync(process.env.HOME, { recursive: true });

function internal(filename) {
  const actual = fs.realpathSync(filename);
  assert(actual.startsWith(root + "/"));
  return actual;
}
function execute(binary, args) {
  return execFileSync(binary, args, {
    cwd: worker,
    env: process.env,
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

const checks = {
  node_abi() {
    assert.equal(process.versions.node, manifest.platform.node);
    assert.equal(
      Number(process.versions.modules),
      manifest.platform.nodeModulesAbi,
    );
    assert.equal(process.env.NODE_PATH, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.equal(process.execPath, node);
  },
  sqlite_query() {
    internal(fromWorker.resolve("better-sqlite3"));
    const db = fromWorker("better-sqlite3")();
    try {
      assert.equal(db.prepare("SELECT 127 AS abi").get().abi, 127);
    } finally {
      db.close();
    }
    assert(
      Object.keys(require.cache).some(
        (name) => name.startsWith(root + "/") && name.endsWith(".node"),
      ),
    );
  },
  pty_load() {
    internal(fromWorker.resolve("node-pty"));
    assert.equal(typeof fromWorker("node-pty").spawn, "function");
    assert(
      Object.keys(require.cache).some(
        (name) => name.startsWith(root + "/") && name.endsWith("/pty.node"),
      ),
    );
  },
  claude_version() {
    const sdk = internal(fromWorker.resolve("@anthropic-ai/claude-agent-sdk"));
    const binary = internal(
      createRequire(sdk).resolve(
        "@anthropic-ai/claude-agent-sdk-linux-x64/claude",
      ),
    );
    assert.equal(
      execute(binary, ["--version"]).split(/\s/)[0],
      manifest.agents.claude.cli,
    );
  },
  codex_version() {
    const wrapper = internal(fromWorker.resolve("@openai/codex/package.json"));
    const native = internal(
      createRequire(wrapper).resolve("@openai/codex-linux-x64/package.json"),
    );
    const binary = internal(
      path.join(
        path.dirname(native),
        "vendor/x86_64-unknown-linux-musl/bin/codex",
      ),
    );
    assert.equal(
      execute(binary, ["--version"]),
      `codex-cli ${manifest.agents.codex.package}`,
    );
    // Also exercise the regenerated JS-wrapper shim and its sibling lookup.
    assert.equal(
      execute(path.join(worker, "node_modules/.bin/codex"), ["--version"]),
      `codex-cli ${manifest.agents.codex.package}`,
    );
  },
  async cursor_load() {
    const sdk = internal(fromWorker.resolve("@cursor/sdk"));
    internal(createRequire(sdk).resolve("@cursor/sdk-linux-x64/package.json"));
    assert(Object.keys(fromWorker("@cursor/sdk")).length > 0);
    // The parent maps engine10003 before installing read-only proc. No nested
    // user namespace is created here; its uid_map would be read-only (#410).
    const helper = await import(pathToFileURL(path.join(root, "lib/zeros/runtime-self-test.mjs")).href);
    assert.equal(helper.probeCursorPlatformPayload(root), true);
  },
  external_modules() {
    for (const name of [
      "postcss",
      "playwright-core",
      "chokidar",
      "ws",
      "tinyglobby",
      "@octokit/rest",
      "ssh2",
    ]) {
      internal(fromWorker.resolve(name));
      fromWorker(name);
    }
  },
  language_servers() {
    for (const name of [
      "tsx",
      "tsc",
      "typescript-language-server",
      "pyright",
    ]) {
      assert(
        execute(path.join(worker, "node_modules/.bin", name), ["--version"])
          .length > 0,
      );
    }
  },
  browser_assets() {
    // chromium.executablePath() names the headed browser. Cloud capture uses
    // headless:true without a channel, which selects the pinned headless shell.
    // Resolve through this package's registry, never an ambient browser/cache.
    const playwright = path.dirname(internal(fromWorker.resolve("playwright-core/package.json")));
    const { registry } = fromWorker(internal(path.join(playwright, "lib/server/registry/index.js")));
    const selected = registry.findExecutable("chromium-headless-shell");
    assert(selected && /^\d+\.\d+\.\d+\.\d+$/.test(selected.browserVersion));
    const browser = internal(selected.executablePath());
    assert(browser.startsWith(path.join(worker, "design-browsers") + "/"));
    assert(fs.lstatSync(browser).isFile());
    assert.equal(execute(browser, ["--version"]).split(/\s/).at(-1), selected.browserVersion);
    internal(path.join(path.dirname(browser), "LICENSE.headless_shell"));
    assert(fs.existsSync(path.join(worker, "design-browsers/NOTICE.txt")));
  },
  runtime_system_assets() {
    // Historical archives keep their original closure contract. A new helper
    // or capability entry opts in; a partially staged new runtime must refuse.
    if (!manifest.files.some(file => ["worker/runtime-system-assets.json", "lib/zeros/cloud-runtime-assets.mjs"].includes(file.path))) return;
    // Names come only from these assertions, never native stderr or paths.
    const subcheck = (name, run) => {
      try { run(); return true; }
      catch { failedChecks.push(`runtime_system_assets_${name}`); return false; }
    };
    if (!subcheck("identity", () => {
      assert.equal(process.geteuid(), 10003);
      assert.equal(process.getegid(), 10003);
    })) return;
    let assets, version;
    if (!subcheck("inventory", () => {
      assets = JSON.parse(fs.readFileSync(path.join(worker, "runtime-system-assets.json"), "utf8"));
      assert.equal(assets.schema, "zeros.runtime-system-assets/v1");
      assert.equal(assets.gitLfs, "bin/git-lfs");
      assert.equal(assets.gitConfig, "worker/gitconfig");
      assert.equal(assets.fontConfig, "worker/design-fonts/fonts.conf");
      assert(Array.isArray(assets.fonts) && assets.fonts.length > 0);
      version = assets.packages.find(pkg => pkg.name === "git-lfs").version.split("-")[0];
      assert(/^\d+\.\d+\.\d+$/.test(version));
    })) return;
    if (!subcheck("files", () => {
      for (const file of [assets.gitLfs, assets.gitConfig, assets.fontConfig, ...assets.fonts]) {
        const filename = internal(path.join(root, file));
        assert(fs.lstatSync(filename).isFile());
      }
    })) return;
    if (!subcheck("environment", () => {
      assert.equal(process.env.GIT_CONFIG_SYSTEM, path.join(worker, "gitconfig"));
      assert.equal(process.env.GIT_EXEC_PATH, `/opt/zeros-infra/.git-exec/${path.basename(root)}`);
      assert.equal(process.env.FONTCONFIG_FILE, path.join(worker, "design-fonts/fonts.conf"));
      assert.equal(process.env.FONTCONFIG_PATH, path.join(worker, "design-fonts"));
    })) return;
    subcheck("git_lfs", () => {
      assert.equal(execute("git", ["--exec-path"]), process.env.GIT_EXEC_PATH);
      assert.equal(internal(path.join(process.env.GIT_EXEC_PATH, "git-lfs")), path.join(root, "bin/git-lfs"));
      assert(execute("git", ["lfs", "version"]).startsWith(`git-lfs/${version} `));
    });
    subcheck("filter", () => {
      const filter = execute("git", ["config", "--system", "--get", "filter.lfs.process"]);
      const lfs = ': "${GIT_CONFIG_SYSTEM:?Missing runtime Git configuration}"; exec "${GIT_CONFIG_SYSTEM%/worker/gitconfig}/bin/git-lfs"';
      assert.equal(filter, `${lfs} filter-process`);
      // Resolve the exact configured shell prefix too, independently of Git's
      // dashed-command lookup. Only the subcommand changes to a bounded probe.
      assert(execute("/bin/sh", ["-c", `${filter.slice(0, -"filter-process".length)}version`])
        .startsWith(`git-lfs/${version} `));
    });
    for (const [family, pkg] of [["Noto Color Emoji", "fonts-noto-color-emoji"], ["Unifont", "fonts-unifont"],
      ["IPAGothic", "fonts-ipafont-gothic"], ["WenQuanYi Zen Hei", "fonts-wqy-zenhei"],
      ["Loma", "fonts-tlwg-loma-otf"], ["FreeSans", "fonts-freefont-ttf"], ["Bitstream Charter", "xfonts-scalable"]])
      subcheck(`font_${pkg.replaceAll("-", "_")}`, () => {
        const [file, matchedFamily] = execute("fc-match", ["--format=%{file}\n%{family}", family]).split("\n");
        assert(file.startsWith(path.join(worker, "design-fonts", pkg) + "/"));
        assert(matchedFamily.split(",").includes(family));
      });
  },
  host_assets() {
    const modules = [
      "host-process-supervisor.mjs",
      "cloud-host-workload-entry.mjs",
      "cloud-workload-cgroup.mjs",
    ].map(name => path.join(worker, "apps/desktop/src/engine/agents/containment", name));
    for (const relative of [
      "bin/cloud-engine-namespace",
      "worker/binaries/rg",
    ])
      internal(path.join(root, relative));
    for (const filename of modules) {
      assert(fs.lstatSync(filename).isFile());
      internal(filename);
      execute(node, ["--check", filename]);
    }
    assert(
      execute(path.join(worker, "binaries/rg"), ["--version"]).startsWith(
        "ripgrep ",
      ),
    );
  },
  qualification_imports() {
    fromWorker("tsx/cjs");
    assert.equal(typeof fromWorker(path.join(worker, "apps/desktop/src/engine/zeros-engine.ts")).ZerosEngine, "function");
    fromWorker(path.join(worker, "apps/desktop/src/engine/agents/gateway.ts"));
    fromWorker(
      path.join(
        worker,
        "apps/desktop/src/engine/agents/containment/host-boundary.ts",
      ),
    );
    fromWorker(
      path.join(
        worker,
        "scripts/cloud-workspace-validation/lib/native-qualification-input.ts",
      ),
    );
    fromWorker(
      path.join(
        worker,
        "scripts/cloud-workspace-validation/lib/native-canary-smoke.ts",
      ),
    );
  },
  qualification_roles() {
    const entry = path.join(worker, "dist-engine/cloud-qualification-roles.mjs");
    assert(fs.lstatSync(entry).isFile());
    internal(entry);
    // The source/import probe above covers historical source consumers. This
    // separate Node must load the new fixed graph with no TypeScript hooks.
    assert.equal(execute(node, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { registerHooks } from 'node:module';
      import { pathToFileURL } from 'node:url';
      const worker = process.argv[1];
      registerHooks({ resolve(specifier, context, next) {
        if (['tsx', 'esbuild'].includes(specifier.split('/')[0]) || specifier.endsWith('.ts'))
          throw new Error('Qualification runtime transform is unavailable');
        return next(specifier, context);
      } });
      const sandbox = worker + '/scripts/cloud-workspace-validation/sandbox';
      const { loadCloudQualificationRoles } = await import(pathToFileURL(sandbox + '/cloud-qualification-loader.mjs'));
      process.argv[1] = sandbox + '/qualify-cloud-engine.mjs';
      const { roles, unregister } = await loadCloudQualificationRoles();
      const compiled = await import(pathToFileURL(worker + '/dist-engine/cloud-qualification-roles.mjs'));
      assert.equal(compiled.createCloudCaptureQualificationRuntime, roles.createCloudQualificationRuntime);
      for (const name of ['createCloudQualificationRuntime', 'qualifyCloudActorTools', 'qualifyCloudCapture', 'qualifyCloudHumanServices']) {
        assert.equal(typeof roles[name], 'function');
        assert.equal(roles[name], compiled[name]);
      }
      await unregister();
      process.stdout.write('qualified-role-imports');
    `, worker]), "qualified-role-imports");
  },
  engine_help() {
    assert(
      execute(node, [
        path.join(worker, "dist-engine/cli.js"),
        "--help",
      ]).includes("Usage:"),
    );
    execute(node, [
      "--check",
      path.join(worker, "dist-engine/design-capture-worker.js"),
    ]);
  },
};

const failedChecks = [];
const selectedChecks = Object.entries(checks).filter(([name]) =>
  (phase === "cursor" ? name === "cursor_load" : name !== "cursor_load") &&
  // Old immutable archives have no compiled entry. New builds always add it;
  // verification of an old artifact must not invent a new required payload.
  (name !== "qualification_roles" || manifest.files?.some(entry => entry.path === "worker/dist-engine/cloud-qualification-roles.mjs")),
);
for (const [name, run] of selectedChecks) {
  try {
    await run();
  } catch {
    failedChecks.push(name);
  }
}
if (!failedChecks.length)
  process.stdout.write(JSON.stringify({ checks: selectedChecks.map(([name]) => name) }) + "\n");
process.stdout.write(
  JSON.stringify({
    schema: "zeros.diagnostic/v1",
    component: "bundle",
    stage: "closure",
    ok: failedChecks.length === 0,
    exitCode: failedChecks.length ? 1 : 0,
    timedOut: false,
    failedChecks,
  }) + "\n",
);
process.exit(failedChecks.length ? 1 : 0);
}
if (require.main === module) main();
