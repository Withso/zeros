#!/usr/bin/env node
// Unified workspaces in the real Electron app (macOS; also runs headless on Linux for development).
//
//   node scripts/native-unified-check.mjs --build     stage main/preload (tsup), install bun into the temp folder
//   node scripts/native-unified-check.mjs --run       drive the app; print the table; exit 0 only if every check passes
//   node scripts/native-unified-check.mjs --cleanup   stop anything left, delete the temp folder, remove this worktree
//
// Everything it writes is under one temporary folder (ZEROS_NATIVE_CHECK_ROOT, default <os tmp>/zeros-native-unified):
// the staged app, its own profile, engine root, HOME, Git config, fixture repositories, Vite cache, screenshots and
// report.json. The app talks only to a fixture control plane on 127.0.0.1, with a fixture session (no keychain, no
// WorkOS, no signed-in session), and registers nothing with the OS. Run from a worktree of its own; --cleanup
// removes that worktree (git worktree remove, then prune) only when it lives under the temp directory.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { createFixtureState, FIXTURE, startFixtureControlPlane } from "./native-unified/control-plane.mjs";
import { startEgressGuard } from "./native-unified/egress.mjs";
import { foreignSockets, killRun, runProcesses, runSockets } from "./native-unified/processes.mjs";
import { PERSON_MUST_LOOK, isLocalUrl, scrub, table } from "./native-unified/report.mjs";
import { CHECKS } from "./native-unified/checks.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.env.ZEROS_NATIVE_CHECK_ROOT ?? path.join(os.tmpdir(), "zeros-native-unified"));
const realHome = os.homedir();
const BUN_VERSION = "1.4.4"; // CI's pin (preflight.yml): the Dev engine runs from source under bun.
const RUN_BUDGET_MS = 9 * 60_000, CHECK_BUDGET_MS = 15_000;
const mode = process.argv[2];
const say = (line) => process.stdout.write(`${scrub(line, { root, home: realHome })}\n`);

async function run(command, args, options = {}) {
  return (await exec(command, args, { cwd: repo, timeout: 8 * 60_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout;
}
/** The person's own Git binary: Homebrew's, then the system's (macOS: only with the developer tools installed). */
async function realGit() {
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]) {
    if (!existsSync(candidate)) continue;
    if (candidate === "/usr/bin/git" && process.platform === "darwin" && !(await run("xcode-select", ["-p"]).then(() => true, () => false))) continue;
    return candidate;
  }
  throw new Error("No Git found in /opt/homebrew/bin, /usr/local/bin or /usr/bin.");
}
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

/** What --build would download and write, and where, without doing any of it. */
async function buildDryRun() {
  const bun = path.join(root, "bun", "node_modules", ".bin", "bun");
  const electron = path.join(repo, "node_modules", "electron", "dist");
  say("--build would:");
  say(existsSync(bun) ? `- reuse bun already in ${path.join(root, "bun")}` : `- download bun@${BUN_VERSION} from the npm registry (registry.npmjs.org: the 'bun' package and its platform binary, about 35 MB) into ${path.join(root, "bun")}`);
  say(existsSync(electron) ? `- use the Electron already installed by pnpm install (${path.relative(repo, electron)}); download nothing for it` : "- find no Electron: run pnpm install first (it downloads Electron); --build itself downloads none");
  say(`- create ${path.join(root, "stage")} (links to this worktree's apps, packages, resources, styles and node_modules) and compile main and preload into it with tsup`);
  say(`- write ${path.join(root, "build.json")} (revision and the fixture control plane's loopback port)`);
  say("- change nothing outside that folder; no network access other than the bun download above");
}

async function build() {
  const started = Date.now();
  await fs.mkdir(root, { recursive: true });
  const bun = path.join(root, "bun", "node_modules", ".bin", "bun");
  if (!existsSync(bun)) {
    say("installing bun into the temp folder");
    await run("npm", ["install", "--prefix", path.join(root, "bun"), "--no-save", "--no-audit", "--no-fund", "--no-package-lock", `bun@${BUN_VERSION}`]);
  }
  const stage = path.join(root, "stage");
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"])
    if (existsSync(path.join(repo, directory))) await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir");
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  // The control plane URL and the cloud switch are baked into main at build: the fixture's port is chosen now.
  const controlPlanePort = await freePort();
  const env = buildEnvironment(controlPlanePort);
  say("compiling main and preload (tsup)");
  await fs.writeFile(path.join(root, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts",
    "--out-dir", path.join(stage, "dist-electron")], { env }));
  const revision = (await run("git", ["rev-parse", "HEAD"])).trim();
  await fs.writeFile(path.join(root, "build.json"), JSON.stringify({ revision, controlPlanePort, builtAt: new Date().toISOString() }, null, 2));
  say(`build ready in ${Math.round((Date.now() - started) / 1000)} s (revision ${revision.slice(0, 12)})`);
}

/** Main's build-time and run-time environment: ordinary Dev (not Local development, which turns cloud and accounts
 * off), cloud on, the fixture control plane as the only backend, and nothing inherited from the person. */
function buildEnvironment(controlPlanePort, ports = { vitePort: 0, engineBase: 0 }, environment = process.env) {
  const identity = { slug: "nativecheck", name: "Zeros Native Check" };
  const env = localEnvironment({ identity, vitePort: ports.vitePort, engineBase: ports.engineBase, environment });
  delete env.ZEROS_LOCAL_DEVELOPMENT;
  Object.assign(env, {
    ZEROS_CHANNEL: "dev", VITE_ZEROS_CHANNEL: "dev", ZEROS_CLOUD_WORKSPACES_ENABLED: "true",
    VITE_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`, ZEROS_CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
    AUTH_PROVIDER: "", AUTH_DESKTOP_CLIENT_ID: "", AUTH_ISSUER: "", AUTH_JWKS_URL: "", AUTH_AUDIENCE: "",
  });
  return env;
}

async function runCheck() {
  const build = JSON.parse(await fs.readFile(path.join(root, "build.json"), "utf8").catch(() => { throw new Error("Run --build first."); }));
  const runDir = path.join(root, "run");
  // A re-run starts clean: anything an earlier run left is stopped, its folder replaced.
  await killRun([], runDir);
  await fs.rm(runDir, { recursive: true, force: true });
  const dirs = Object.fromEntries(["home", "tmp", "profile", "fixtures", "shots", "xdg-config", "xdg-data", "xdg-cache"].map(name => [name, path.join(runDir, name)]));
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
  const rows = [], report = { revision: build.revision, platform: `${process.platform}-${process.arch}`, checks: rows };
  const row = (check, result, fact) => { rows.push({ check, result, fact: String(fact) }); };
  const state = createFixtureState();
  let controlPlane, egress, vite, app, page, electronPid = null;
  const teardown = async (reason) => {
    try { await Promise.race([app?.close(), delay(5000)]); } catch { /* killed below */ }
    const stopped = await killRun([electronPid, vite?.pid].filter(Boolean), runDir);
    await controlPlane?.close().catch(() => undefined);
    await egress?.close().catch(() => undefined);
    const fact = `${reason}: stopped ${stopped.stopped} process(es) by process group; ${stopped.left} left`;
    row("teardown", stopped.left === 0 ? "pass" : "fail", fact);
  };
  const deadline = setTimeout(async () => {
    row("budget", "fail", `the run passed ${RUN_BUDGET_MS / 60_000} minutes`);
    await teardown("timeout");
    finish(rows, runDir, report, 124);
  }, RUN_BUDGET_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await teardown(signal); finish(rows, runDir, report, 130); });
  try {
    controlPlane = await startFixtureControlPlane(state, build.controlPlanePort).catch(error => {
      throw new Error(`The fixture control plane's port ${build.controlPlanePort} (chosen at --build) is busy; run --build again. ${error.code ?? ""}`);
    });
    egress = await startEgressGuard();
    const ports = await pickLocalPorts(`nativecheck-${randomUUID().slice(0, 8)}`);
    const gitconfig = path.join(runDir, "gitconfig");
    // The app's tools, and only these: the person's real Git (never a wrapper on their PATH), this Node, the temp
    // bun, and a gh that has nobody signed in (gh reads the keychain otherwise). A stub login shell keeps that PATH
    // when main hydrates it from the "login shell", and never reads the person's shell profile.
    const bin = path.join(runDir, "bin");
    await fs.mkdir(bin, { recursive: true });
    // git and the stubs log each run (N13 reports which ran); security is a stub too, so the keychain CLI is unreachable.
    const calls = path.join(runDir, "tool-calls.log");
    // The engine drops every GIT_* variable before it runs Git (git-exec.ts gitChildEnv), so the run's config is
    // set here, after that: every Git in the run reads this run's global file and no system file.
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\necho git >> '${calls}'\nGIT_CONFIG_GLOBAL='${gitconfig}'\nGIT_CONFIG_NOSYSTEM=1\n`
      + `export GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM\n`
      // Dev aid: Git's own trace of every command the app runs (the run has no credentials to show).
      + (process.env.ZEROS_NATIVE_CHECK_GIT_TRACE ? `GIT_TRACE='${path.join(runDir, "git-trace.log")}'\nexport GIT_TRACE\nexec 2>>'${path.join(runDir, "git-stderr.log")}'\n` : "")
      + `exec '${await realGit()}' "$@"\n`, { mode: 0o755 });
    await fs.symlink(process.execPath, path.join(bin, "node"));
    await fs.symlink(path.join(root, "bun", "node_modules", ".bin", "bun"), path.join(bin, "bun"));
    await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\necho gh >> '${calls}'\necho 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2\nexit 1\n`, { mode: 0o755 });
    await fs.writeFile(path.join(bin, "security"), `#!/bin/sh\necho security >> '${calls}'\necho 'security: not available in the native check' >&2\nexit 1\n`, { mode: 0o755 });
    const systemPath = `${bin}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`;
    const shell = path.join(bin, "login-shell");
    await fs.writeFile(shell, `#!/bin/sh\nexport PATH="${systemPath}"\nwhile [ $# -gt 0 ]; do case "$1" in -*c*) shift; exec /bin/sh -c "$@";; -*) shift;; *) exec /bin/sh "$@";; esac; done\nexec /bin/sh\n`, { mode: 0o755 });
    // Nothing of the person's environment beyond locale and user name: no tokens, keys, agents' or tools' settings.
    const base = { PATH: systemPath, SHELL: shell, LANG: process.env.LANG || "en_US.UTF-8", USER: process.env.USER ?? "native-check", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "native-check" };
    const context = { root: runDir, dirs, gitconfig, state, controlPlane, row, report, repo };
    const env = {
      ...buildEnvironment(build.controlPlanePort, ports, base),
      ZEROS_ISOLATE: "1", ZEROS_NO_ENGINE_HMR: "1", ZEROS_NO_MAIN_HMR: "1", ZEROS_DATA_DIR: dirs.profile,
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}`,
      HOME: dirs.home, TMPDIR: dirs.tmp, XDG_CONFIG_HOME: dirs["xdg-config"], XDG_DATA_HOME: dirs["xdg-data"], XDG_CACHE_HOME: dirs["xdg-cache"],
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Native Check", GIT_AUTHOR_EMAIL: FIXTURE.email, GIT_COMMITTER_NAME: "Native Check", GIT_COMMITTER_EMAIL: FIXTURE.email,
      // Main puts this Node's folder first on PATH (shell-path.ts): the run's own link, not the folder Node lives in
      // (on a Mac that can be Homebrew's, with the person's gh).
      ZEROS_DEV_NODE_EXECUTABLE: path.join(bin, "node"),
      ZEROS_NATIVE_CHECK_HOOK_LOG: path.join(runDir, "hook.log"),
      // Every proxy-aware client (git, bun's fetch, CLIs) reaches only the egress guard, which refuses and records.
      HTTPS_PROXY: egress.url, HTTP_PROXY: egress.url, ALL_PROXY: egress.url, https_proxy: egress.url, http_proxy: egress.url, all_proxy: egress.url,
      NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
      ZEROS_NATIVE_CHECK_USER: JSON.stringify({ sub: FIXTURE.user, accountId: FIXTURE.user, email: FIXTURE.email, name: "Fixture", provider: "workos" }),
    };
    // No credential helper (an empty value resets every one), no hooks path, no excludes file: none of the person's.
    await fs.writeFile(gitconfig, `[user]\n\tname = Native Check\n\temail = ${FIXTURE.email}\n[credential]\n\thelper =\n[protocol "file"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n`);
    context.env = env;
    for (const prepare of CHECKS.flatMap(check => check.prepare ? [check.prepare] : [])) await prepare(context);

    const viteConfig = path.join(runDir, "vite.config.mjs");
    // The app's own Vite config: its dependency cache stays in the worktree's node_modules/.vite (the worktree
    // is itself in a temp folder), where Vite allows it.
    await fs.writeFile(viteConfig, `export { default } from ${JSON.stringify(path.join(repo, "vite.config.ts"))};\n`);
    const viteLog = await fs.open(path.join(runDir, "vite.log"), "w");
    vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"],
      { cwd: repo, env, stdio: ["ignore", viteLog.fd, viteLog.fd], detached: true });
    const viteBy = Date.now() + 90_000;
    while (!(await fetch(env.ELECTRON_RENDERER_URL).then(response => response.ok, () => false))) {
      if (Date.now() > viteBy) throw new Error("The renderer's Vite server did not start within 90 s.");
      await delay(200);
    }
    // Electron's own -r loads the hook into main (Playwright drops NODE_OPTIONS).
    const args = ["-r", path.join(repo, "scripts", "native-unified", "main-hook.cjs"), path.join(root, "stage"), `--log-net-log=${path.join(runDir, "netlog.json")}`];
    if (process.platform === "darwin") args.push("--use-mock-keychain");
    if (process.platform === "linux") args.push("--ozone-platform=headless", "--disable-gpu", "--no-sandbox", "--password-store=basic");
    app = await launchNativeElectron({ args, cwd: dirs.fixtures, env, timeout: 90_000 });
    electronPid = app.process().pid;
    page = await app.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(CHECK_BUDGET_MS);
    page.on("request", request => { (report.rendererRequests ??= []).push(request.url()); });
    page.on("console", message => { if (message.type() === "error") (report.console ??= []).push(message.text().slice(0, 300)); });
    page.on("pageerror", error => { (report.pageErrors ??= []).push(String(error).slice(0, 300)); });
    page.on("response", response => { if (response.status() >= 400) (report.failedResponses ??= []).push(`${response.status()} ${response.url()}`); });
    context.page = page;
    await page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, null, { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setBounds({ x: 40, y: 40, width: 1440, height: 960 }); });
    Object.assign(context, { app, page, electronPid });

    // ZEROS_NATIVE_CHECK_ONLY=id,id runs a subset (development); the table then says which were left out.
    const only = process.env.ZEROS_NATIVE_CHECK_ONLY?.split(",").map(value => value.trim()).filter(Boolean);
    for (const check of CHECKS) {
      if (!check.run) continue;
      if (only && !only.some(prefix => check.id.startsWith(prefix))) { row(check.id, "n/a", "left out by ZEROS_NATIVE_CHECK_ONLY"); continue; }
      const started = Date.now();
      try {
        const outcome = await Promise.race([check.run(context), delay(check.budgetMs ?? 45_000).then(() => { throw new Error(`no result within ${(check.budgetMs ?? 45_000) / 1000} s`); })]);
        if (outcome) row(check.id, outcome.result, outcome.fact);
      } catch (error) {
        row(check.id, "fail", `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
        await page.screenshot({ path: path.join(dirs.shots, `${check.id}-failure.png`) }).catch(() => undefined);
        // Development aid: the visible controls' accessible names at the failure.
        if (process.env.ZEROS_NATIVE_CHECK_DUMP) (report.dom ??= {})[check.id] = await page.evaluate(() => [...document.querySelectorAll("button, [role=tab], [role=tablist], [role=menuitem], a, [role=switch]")]
          .filter(element => element.getClientRects().length).map(element => `${element.getAttribute("role") ?? element.tagName.toLowerCase()}:${element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 40)}`)).catch(() => []);
      }
      (report.timings ??= {})[check.id] = Date.now() - started;
    }

    // N12: nothing beyond loopback, requested or listened on.
    const processes = await runProcesses([electronPid, vite?.pid].filter(Boolean), runDir), pids = processes.map(row => row.pid);
    const nameOf = (pid) => path.basename((processes.find(row => row.pid === pid)?.command ?? "?").split(" ")[0]);
    const sockets = await runSockets(pids);
    const foreign = foreignSockets(sockets);
    report.foreignSockets = foreign.map(socket => ({ ...socket, command: (processes.find(row => row.pid === socket.pid)?.command ?? "?").slice(0, 300) }));
    const netlog = await fs.readFile(path.join(runDir, "netlog.json"), "utf8").catch(() => "");
    const urls = [...new Set([...(report.rendererRequests ?? []), ...[...netlog.matchAll(/"url":"([^"]+)"/g)].map(match => match[1])])];
    const outside = urls.filter(url => !isLocalUrl(url));
    const refused = [...new Set(egress.attempts.map(attempt => attempt.host))];
    row("N12 loopback only", foreign.length || outside.length || refused.length ? "fail" : "pass",
      `${urls.length} distinct URLs, ${outside.length} beyond loopback${outside.length ? ` (${outside.slice(0, 3).map(url => new URL(url).host).join(", ")})` : ""}; `
      + `egress guard: ${egress.attempts.length} attempt(s)${refused.length ? ` refused (${refused.slice(0, 4).join(", ")})` : ""}; `
      + `${sockets.filter(socket => socket.state === "LISTEN").length} listening and ${sockets.length} TCP sockets in ${pids.length} processes, `
      + `${foreign.length} not on loopback${foreign.length ? ` (${foreign.slice(0, 3).map(socket => `${nameOf(socket.pid)} ${socket.state} ${socket.remote ?? socket.local}`).join(", ")})` : ""}`);
  } catch (error) {
    row("setup", "fail", error instanceof Error ? error.message.split("\n")[0] : String(error));
    report.setupUrl = page?.url();
    await page?.screenshot({ path: path.join(dirs.shots, "setup-failure.png") }).catch(() => undefined);
  }
  report.controlPlaneRequests = state.requests.map(request => `${request.method} ${request.path}`);
  report.unserved = [...(state.unserved ?? [])];
  clearTimeout(deadline);
  await teardown("end of run");
  finish(rows, runDir, report, rows.some(entry => entry.result === "fail") ? 1 : 0);
}

let finished = false;
function finish(rows, runDir, report, code) {
  if (finished) return;
  finished = true;
  const { text } = table(rows, { root, home: realHome });
  say(text);
  say("\nStill for a person to look at:");
  for (const item of PERSON_MUST_LOOK) say(`- ${item}`);
  void fs.writeFile(path.join(runDir, "report.json"), scrub(JSON.stringify(report, null, 2), { root, home: realHome })).finally(() => process.exit(code));
}

async function cleanup() {
  const stopped = await killRun([], root);
  await fs.rm(root, { recursive: true, force: true });
  say(`stopped ${stopped.stopped} process(es); removed the temp folder`);
  // This worktree, only when it is a linked worktree living under the temp directory: never a person's checkout.
  const gitDir = (await run("git", ["rev-parse", "--git-dir"]).catch(() => "")).trim();
  const common = (await run("git", ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
  const top = (await run("git", ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  const tmp = await fs.realpath(os.tmpdir());
  const realTop = top ? await fs.realpath(top).catch(() => top) : "";
  if (gitDir && common && path.resolve(repo, gitDir) !== path.resolve(repo, common) && realTop.startsWith(`${tmp}${path.sep}`)) {
    const main = path.dirname(path.resolve(repo, common));
    await run("git", ["-C", main, "worktree", "remove", "--force", realTop]);
    await run("git", ["-C", main, "worktree", "prune"]);
    say("removed this worktree (git worktree remove, then prune)");
  } else say("left the checkout alone: it is not a linked worktree under the temp directory");
}

if (mode === "--build" && process.argv.includes("--dry-run")) await buildDryRun();
else if (mode === "--build") await build();
else if (mode === "--run") await runCheck();
else if (mode === "--cleanup") await cleanup();
else { say("Usage: node scripts/native-unified-check.mjs --build [--dry-run] | --run | --cleanup"); process.exit(2); }
