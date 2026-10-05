// Executed only after archive verification, under the bundled Node in a mount
// namespace that contains the runtime and OS libraries, with networking off.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

const root = process.argv[2];
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
  cursor_load() {
    const sdk = internal(fromWorker.resolve("@cursor/sdk"));
    internal(createRequire(sdk).resolve("@cursor/sdk-linux-x64/package.json"));
    assert(Object.keys(fromWorker("@cursor/sdk")).length > 0);
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
      "@anthropic-ai/sandbox-runtime",
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
    const playwright = fromWorker("playwright-core");
    const browser = internal(playwright.chromium.executablePath());
    assert(browser.startsWith(path.join(worker, "design-browsers") + "/"));
    assert(fs.existsSync(path.join(worker, "design-browsers/NOTICE.txt")));
  },
  supervisor_assets() {
    for (const relative of [
      "bin/cloud-engine-namespace",
      "bin/cloud-process-supervisor",
      "worker/binaries/zsr-supervisor.mjs",
      "worker/binaries/zsr-rg",
    ])
      internal(path.join(root, relative));
    execute(node, [
      "--check",
      path.join(worker, "binaries/zsr-supervisor.mjs"),
    ]);
    assert(
      execute(path.join(worker, "binaries/zsr-rg"), ["--version"]).startsWith(
        "ripgrep ",
      ),
    );
  },
  qualification_imports() {
    fromWorker("tsx/cjs");
    fromWorker(path.join(worker, "apps/desktop/src/engine/agents/gateway.ts"));
    fromWorker(
      path.join(
        worker,
        "apps/desktop/src/engine/agents/containment/zsr-boundary.ts",
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
for (const [name, run] of Object.entries(checks)) {
  try {
    run();
  } catch {
    failedChecks.push(name);
  }
}
if (!failedChecks.length)
  process.stdout.write(JSON.stringify({ checks: Object.keys(checks) }) + "\n");
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
