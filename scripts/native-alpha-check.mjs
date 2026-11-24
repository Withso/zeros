#!/usr/bin/env node
// Cloud workflows in the real Electron app against Alpha, signed in as a numbered test user (macOS; also runs headless
// on Linux for development).
//
//   node scripts/native-alpha-check.mjs --build     stage main/preload with Alpha's public sign-in settings, install bun
//   node scripts/native-alpha-check.mjs --run       set the account up, drive the app, clean up; print the table
//   node scripts/native-alpha-check.mjs --cleanup   revoke a session a killed run left, put the account back, delete the
//                                                    temp folder, remove this worktree
//
// Everything it writes is under one temporary folder (ZEROS_NATIVE_ALPHA_ROOT, default <os tmp>/zeros-native-alpha):
// the staged app, its own profile (its session store too: no keychain), engine root, HOME, Git config, screenshots and
// report.json. It registers nothing with the OS. The account is ZEROS_NATIVE_ALPHA_ACCOUNT (a numbered test user,
// default 9; never the owner, never 2 or 3, which the rehearsal uses). Its Pro, GitHub sign-in and agent logins come
// from the rehearsal's own setup stage, recorded first and put back by the rehearsal's cleanup at the end
// (ZEROS_NATIVE_ALPHA_PRO_ACTOR names the platform owner that acts for Pro, as the rehearsal's --pro-actor;
// ZEROS_DEV_PROFILE_PATH is the rehearsal's private profile). Sign-in is the app's own: the sign-in page is filled in
// a separate headless browser, and its callback handed to the app as a second instance. Credentials come from
// .env.agent, in memory only. Both the app and that browser reach only Alpha, WorkOS and GitHub (egress guard).
/* global document, window, atob, AbortSignal -- document, window and atob are read inside page.evaluate (the renderer) */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseEnv, promisify } from "node:util";
import { ensureDevAuthEnvironment, DEV_AUTH_ENV_KEYS } from "./dev-auth-profile.mjs";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { CHECKS, settle } from "./native-alpha/checks.mjs";
import { startEgressGuard } from "./native-alpha/egress.mjs";
import { PERSON_MUST_LOOK, accountNumber, inventoryClean, rehearsalRunId } from "./native-alpha/report.mjs";
import { completeHostedSignIn } from "./native-alpha/signin.mjs";
import { foreignSockets, identify, killRun, runProcesses, runSockets } from "./native-unified/processes.mjs";
import { scrub, table } from "./native-unified/report.mjs";
import { electronInstall, worktreeRemoval } from "./native-unified/setup.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(process.env.ZEROS_NATIVE_ALPHA_ROOT ?? path.join(os.tmpdir(), "zeros-native-alpha"));
const realHome = os.homedir();
const ALPHA_API = "https://api-alpha.zeros.build";
const BUN_VERSION = "1.4.4"; // CI's pin (preflight.yml): the Dev engine runs from source under bun.
const RUN_BUDGET_MS = 120 * 60_000;
const FIXTURE_ONE = process.env.ZEROS_NATIVE_ALPHA_REPOSITORY ?? "Withso/zeros-dev-fixture";
const FIXTURE_TWO = process.env.ZEROS_NATIVE_ALPHA_REPOSITORY_TWO ?? "Withso/zeros-dev-fixture-2";
const mode = process.argv[2];
const say = (line) => process.stdout.write(`${scrub(line, { root, home: realHome })}\n`);
const statePath = path.join(root, "state.json");
const readState = async () => JSON.parse(await fs.readFile(statePath, "utf8").catch(() => "{}"));
const writeState = async (patch) => fs.writeFile(statePath, JSON.stringify({ ...await readState(), ...patch }, null, 2), { mode: 0o600 });

async function run(command, args, options = {}) {
  return (await exec(command, args, { cwd: repo, timeout: 8 * 60_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout;
}
/** .env.agent, read into memory once; values are never printed. */
function agentEnv() {
  const file = path.join(repo, ".env.agent");
  if (!existsSync(file)) throw new Error("No .env.agent at the repository root.");
  return parseEnv(readFileSync(file, "utf8"));
}
async function realGit() {
  for (const candidate of ["/opt/homebrew/bin/git", "/usr/local/bin/git", "/usr/bin/git"]) {
    if (!existsSync(candidate)) continue;
    if (candidate === "/usr/bin/git" && process.platform === "darwin" && !(await run("xcode-select", ["-p"]).then(() => true, () => false))) continue;
    return candidate;
  }
  throw new Error("No Git found in /opt/homebrew/bin, /usr/local/bin or /usr/bin.");
}

/** Main's build-time and run-time environment: ordinary Dev against Alpha (the only contract a Dev desktop accepts),
 * cloud on, and nothing inherited from the person. */
function buildEnvironment(auth, ports = { vitePort: 0, engineBase: 0 }, environment = process.env) {
  const env = localEnvironment({ identity: { slug: "nativealpha", name: "Zeros Alpha Check" }, vitePort: ports.vitePort, engineBase: ports.engineBase, environment });
  delete env.ZEROS_LOCAL_DEVELOPMENT;
  Object.assign(env, { ZEROS_CHANNEL: "dev", VITE_ZEROS_CHANNEL: "dev", ZEROS_CLOUD_WORKSPACES_ENABLED: "true", ZEROS_CONTROL_PLANE_URL: ALPHA_API, ...auth });
  return env;
}

async function build() {
  const started = Date.now();
  const electron = electronInstall(path.join(repo, "node_modules", "electron"));
  if (!electron.version) throw new Error(`No Electron package (${electron.reason}).`);
  if (!electron.installed) {
    say(`downloading Electron ${electron.version} from Electron's releases (about 100 MB): ${electron.reason}`);
    await run(process.execPath, [path.join(repo, "node_modules", "electron", "install.js")], { cwd: path.join(repo, "node_modules", "electron") });
  }
  await fs.mkdir(root, { recursive: true });
  const bun = path.join(root, "bun", "node_modules", ".bin", "bun");
  if (!existsSync(bun)) {
    say("installing bun into the temp folder");
    await run("npm", ["install", "--prefix", path.join(root, "bun"), "--no-save", "--no-audit", "--no-fund", "--no-package-lock", `bun@${BUN_VERSION}`]);
  }
  // Alpha's public sign-in settings for Dev desktops, read once into the temp folder (never the person's ~/.zeros-dev).
  const authHome = path.join(root, "auth-home");
  await fs.mkdir(authHome, { recursive: true, mode: 0o700 });
  const profile = await ensureDevAuthEnvironment({ homeDir: authHome, processEnv: {} });
  if (profile.issue) throw new Error(`Alpha's public sign-in settings are invalid (${profile.issue}).`);
  const auth = Object.fromEntries(DEV_AUTH_ENV_KEYS.map(name => [name, profile.env[name]]));
  const stage = path.join(root, "stage");
  await fs.rm(stage, { recursive: true, force: true });
  await fs.mkdir(stage, { recursive: true });
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"])
    if (existsSync(path.join(repo, directory))) await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir");
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  say("compiling main and preload (tsup)");
  await fs.writeFile(path.join(root, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts",
    "--out-dir", path.join(stage, "dist-electron")], { env: buildEnvironment(auth) }));
  const revision = (await run("git", ["rev-parse", "HEAD"])).trim();
  await fs.writeFile(path.join(root, "build.json"), JSON.stringify({ revision, auth, builtAt: new Date().toISOString() }, null, 2));
  say(`build ready in ${Math.round((Date.now() - started) / 1000)} s (revision ${revision.slice(0, 12)})`);
}

/** The rehearsal's own CLI for the account's setup and clean-up: its output is already safe to print. */
async function rehearse(args, account) {
  const env = { ...process.env };
  if (!env.ZEROS_DEV_PROFILE_PATH) throw new Error("Set ZEROS_DEV_PROFILE_PATH to the rehearsal's private profile.");
  const proActor = env.ZEROS_NATIVE_ALPHA_PRO_ACTOR;
  if (!proActor || !/^[0-9a-f]{8}$/.test(proActor)) throw new Error("Set ZEROS_NATIVE_ALPHA_PRO_ACTOR to the platform owner's first 8 hex (the rehearsal's --pro-actor).");
  const out = await run("pnpm", ["alpha:rehearse", ...args, "--account", String(account), "--pro-actor", proActor, "--repository", FIXTURE_ONE,
    "--switches", "projects,personal,retention"], { env, timeout: 30 * 60_000 }).catch(error => `${error.stdout ?? ""}\nfailed: exit ${error.code}`);
  return out.split("\n").filter(line => line.startsWith("[rehearse]") || line.startsWith("failed:")).join("\n");
}

/** Revokes a provider session by id with the Alpha WorkOS key (clean-up after a kill, or when the app is gone). */
async function revokeSession(sessionId, apiKey) {
  const response = await fetch("https://api.workos.com/user_management/sessions/revoke", { method: "POST", redirect: "error",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ session_id: sessionId }),
    signal: AbortSignal.timeout(15_000) });
  await response.body?.cancel();
  return response.status;
}

async function runCheck() {
  const build = JSON.parse(await fs.readFile(path.join(root, "build.json"), "utf8").catch(() => { throw new Error("Run --build first."); }));
  const account = accountNumber(process.env.ZEROS_NATIVE_ALPHA_ACCOUNT ?? "9");
  const secrets = agentEnv();
  const password = secrets[`ZEROS_TEST_USER_${account}_PASSWORD`];
  if (!password) throw new Error(`No password for test user ${account} in .env.agent.`);
  const runDir = path.join(root, "run");
  await killRun([], runDir);
  await fs.rm(runDir, { recursive: true, force: true });
  const dirs = Object.fromEntries(["home", "tmp", "profile", "fixtures", "shots", "xdg-config", "xdg-data", "xdg-cache"].map(name => [name, path.join(runDir, name)]));
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
  const rows = [], report = { revision: build.revision, platform: `${process.platform}-${process.arch}`, account, checks: rows };
  const row = (check, result, fact) => { rows.push({ check, result, fact: String(fact) }); say(`  ${check}: ${result} ${String(fact).slice(0, 200)}`); };
  let egress, vite, app, page, signedIn = false;
  const roots = [];
  const context = { root: runDir, dirs, row, report, repo, account, email: `user-${account}@zeros.build`, fixtureOne: FIXTURE_ONE, fixtureTwo: FIXTURE_TWO, created: { projects: [], workspaces: [] } };
  const teardown = async (reason) => {
    // Sign out through the app's own UI, then make sure the provider session is gone whatever happened.
    if (signedIn && page) {
      await settle(page).catch(() => undefined);
      const outcome = await CHECKS.find(check => check.id === "signout")?.run(context).catch(error => ({ result: "fail", fact: error.message }));
      if (outcome) row("sign-out", outcome.result, outcome.fact);
    }
    const { sessionId } = await readState();
    if (sessionId) {
      const status = await revokeSession(sessionId, secrets.WORKOS_ALPHA_API_KEY).catch(() => "network");
      row("session revoked", [200, 204, 404].includes(status) ? "pass" : "fail", `provider session revoke: http ${status}`);
      if ([200, 204, 404].includes(status)) await writeState({ sessionId: null });
    }
    try { await Promise.race([app?.close(), delay(5000)]); } catch { /* killed below */ }
    const stopped = await killRun(roots, runDir);
    await egress?.close().catch(() => undefined);
    await fs.rm(dirs.profile, { recursive: true, force: true });
    row("teardown", stopped.left === 0 ? "pass" : "fail", `${reason}: stopped ${stopped.stopped} process(es); ${stopped.left} left; isolated profile deleted`);
  };
  const deadline = setTimeout(async () => { row("budget", "fail", `the run passed ${RUN_BUDGET_MS / 60_000} minutes`); await teardown("timeout"); finish(rows, runDir, report, 124); }, RUN_BUDGET_MS);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => { await teardown(signal); finish(rows, runDir, report, 130); });
  try {
    // The account: the rehearsal's own setup stage (Pro, its GitHub sign-in, agent logins), recorded and put back later.
    const setupStarted = Date.now();
    const state = await readState();
    let runId = state.runId;
    if (!runId || state.cleanedUp) {
      say(`setting up test user ${account} with the rehearsal's setup stage`);
      const out = await rehearse(["setup"], account);
      runId = rehearsalRunId(out);
      if (runId) await writeState({ runId, account, cleanedUp: false });
      if (!runId || !/stage setup: ok/.test(out)) throw new Error(`the rehearsal's setup did not finish (${out.split("\n").filter(line => /failed|stage setup/.test(line)).join("; ").slice(0, 200)})`);
    }
    (report.timings ??= {})["account setup"] = Date.now() - setupStarted;
    row("account setup", "pass", `test user ${account} through the rehearsal's setup stage (run ${runId.slice(0, 8)}): Pro, its GitHub sign-in and agent logins`);
    context.runId = runId;
    // The rehearsal's own prefix: everything the check names carries it, so the rehearsal's clean-up and inventory see it.
    context.prefix = `zr-${runId.slice(0, 8)}-`;

    egress = await startEgressGuard();
    context.egress = egress;
    const ports = await pickLocalPorts(`nativealpha-${randomUUID().slice(0, 8)}`);
    const gitconfig = path.join(runDir, "gitconfig");
    const bin = path.join(runDir, "bin");
    await fs.mkdir(bin, { recursive: true });
    const calls = path.join(runDir, "tool-calls.log");
    await fs.writeFile(path.join(bin, "git"), `#!/bin/sh\necho git >> '${calls}'\nGIT_CONFIG_GLOBAL='${gitconfig}'\nGIT_CONFIG_NOSYSTEM=1\nexport GIT_CONFIG_GLOBAL GIT_CONFIG_NOSYSTEM\nexec '${await realGit()}' "$@"\n`, { mode: 0o755 });
    await fs.symlink(process.execPath, path.join(bin, "node"));
    await fs.symlink(path.join(root, "bun", "node_modules", ".bin", "bun"), path.join(bin, "bun"));
    await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\necho gh >> '${calls}'\necho 'You are not logged into any GitHub hosts. To log in, run: gh auth login' >&2\nexit 1\n`, { mode: 0o755 });
    await fs.writeFile(path.join(bin, "security"), `#!/bin/sh\necho security >> '${calls}'\necho 'security: not available in the Alpha check' >&2\nexit 1\n`, { mode: 0o755 });
    const systemPath = `${bin}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`;
    const shell = path.join(bin, "login-shell");
    await fs.writeFile(shell, `#!/bin/sh\nexport PATH="${systemPath}"\nwhile [ $# -gt 0 ]; do case "$1" in -*c*) shift; exec /bin/sh -c "$@";; -*) shift;; *) exec /bin/sh "$@";; esac; done\nexec /bin/sh\n`, { mode: 0o755 });
    const base = { PATH: systemPath, SHELL: shell, LANG: process.env.LANG || "en_US.UTF-8", USER: process.env.USER ?? "native-alpha", LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "native-alpha" };
    const env = {
      ...buildEnvironment(build.auth, ports, base),
      ZEROS_ISOLATE: "1", ZEROS_NO_ENGINE_HMR: "1", ZEROS_NO_MAIN_HMR: "1", ZEROS_DATA_DIR: dirs.profile,
      ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}`,
      HOME: dirs.home, TMPDIR: dirs.tmp, XDG_CONFIG_HOME: dirs["xdg-config"], XDG_DATA_HOME: dirs["xdg-data"], XDG_CACHE_HOME: dirs["xdg-cache"],
      GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      ZEROS_DEV_NODE_EXECUTABLE: path.join(bin, "node"),
      ZEROS_NATIVE_ALPHA_CHECK: "1", ZEROS_NATIVE_ALPHA_HOOK_LOG: path.join(runDir, "hook.log"),
      // Node's fetch in main follows these too (NODE_USE_ENV_PROXY); Chromium gets --proxy-server below.
      HTTPS_PROXY: egress.url, HTTP_PROXY: egress.url, ALL_PROXY: egress.url, https_proxy: egress.url, http_proxy: egress.url, all_proxy: egress.url,
      NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", NODE_USE_ENV_PROXY: "1",
    };
    await fs.writeFile(gitconfig, `[user]\n\tname = Alpha Check\n\temail = ${context.email}\n[credential]\n\thelper =\n[init]\n\tdefaultBranch = main\n`);
    context.env = env;

    const viteConfig = path.join(runDir, "vite.config.mjs");
    await fs.writeFile(viteConfig, `export { default } from ${JSON.stringify(path.join(repo, "vite.config.ts"))};\n`);
    const viteLog = await fs.open(path.join(runDir, "vite.log"), "w");
    vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--config", viteConfig, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"],
      { cwd: repo, env, stdio: ["ignore", viteLog.fd, viteLog.fd], detached: true });
    roots.push(await identify(vite.pid));
    const viteBy = Date.now() + 90_000;
    while (!(await fetch(env.ELECTRON_RENDERER_URL).then(response => response.ok, () => false))) {
      if (Date.now() > viteBy) throw new Error("The renderer's Vite server did not start within 90 s.");
      await delay(200);
    }
    const args = ["-r", path.join(repo, "scripts", "native-alpha", "main-hook.cjs"), path.join(root, "stage"),
      `--proxy-server=${egress.url}`, `--log-net-log=${path.join(runDir, "netlog.json")}`];
    if (process.platform === "darwin") args.push("--use-mock-keychain");
    if (process.platform === "linux") args.push("--ozone-platform=headless", "--disable-gpu", "--no-sandbox", "--password-store=basic", "--disable-dev-shm-usage");
    app = await launchNativeElectron({ args, cwd: dirs.fixtures, env, timeout: 90_000 });
    roots.push(await identify(app.process().pid));
    page = await app.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(30_000);
    page.on("console", message => { if (message.type() === "error") (report.console ??= []).push(message.text().slice(0, 300)); });
    page.on("pageerror", error => { (report.pageErrors ??= []).push(String(error).slice(0, 300)); });
    page.on("response", response => { if (response.status() >= 400) (report.failedResponses ??= []).push(`${response.status()} ${new URL(response.url()).pathname}`); });
    await page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0, null, { timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setBounds({ x: 40, y: 40, width: 1440, height: 960 }); });
    Object.assign(context, { app, page });

    // Sign-in: the app's own button and PKCE flow; AuthKit filled in a separate headless browser.
    const signInStarted = Date.now();
    await page.getByRole("button", { name: "Sign in", exact: true }).first().click({ timeout: 60_000 });
    let authorizeUrl;
    for (let i = 0; i < 100 && !authorizeUrl; i++) {
      authorizeUrl = await app.evaluate(() => globalThis.__zerosAlphaCheckOpened?.at(-1));
      if (!authorizeUrl) await delay(200);
    }
    if (!authorizeUrl) throw new Error("The app's sign-in did not ask to open a browser.");
    const { link, passkeyOfferSkipped } = await completeHostedSignIn({ authorizeUrl, email: context.email, password, proxyUrl: egress.url });
    await app.evaluate(({ app: electronApp }, url) => { electronApp.emit("second-instance", { preventDefault() {} }, [process.execPath, url], process.cwd()); }, link);
    await page.getByRole("button", { name: "Open settings", exact: true }).first().waitFor({ timeout: 60_000 });
    signedIn = true;
    // The provider session id, read inside the renderer so the token never leaves it: --cleanup revokes it after a kill.
    const sessionId = await page.evaluate(async () => {
      const reply = await window.__ZEROS_NATIVE__.invoke("auth_get_access_token");
      const token = typeof reply === "string" ? reply : reply?.access_token;
      try { return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sid ?? null; } catch { return null; }
    });
    if (sessionId) await writeState({ sessionId });
    await page.screenshot({ path: path.join(dirs.shots, "00-signed-in.png") });
    (report.timings ??= {})["sign-in"] = Date.now() - signInStarted;
    row("sign-in", sessionId ? "pass" : "fail", `the app's own sign-in as ${context.email} in ${Math.round((Date.now() - signInStarted) / 1000)} s; passkey offer ${passkeyOfferSkipped ? "skipped" : "not shown"}; session ${sessionId ? "recorded for clean-up" : "id unreadable"}`);

    // Development aid: ZEROS_NATIVE_ALPHA_HOLD=1 keeps the signed-in app up and runs each script written to
    // <run>/eval.mjs (its default export gets the context), writing what it returns to <run>/eval.out; "stop" ends.
    if (process.env.ZEROS_NATIVE_ALPHA_HOLD === "1") await hold(context);
    const only = process.env.ZEROS_NATIVE_ALPHA_ONLY?.split(",").map(value => value.trim()).filter(Boolean);
    for (const check of CHECKS) {
      if (!check.run || check.id === "signout") continue;
      if (only && !only.some(prefix => check.id.startsWith(prefix))) { row(check.id, "n/a", "left out by ZEROS_NATIVE_ALPHA_ONLY"); continue; }
      const started = Date.now();
      try {
        await settle(context.page).catch(() => undefined);
        const outcome = await Promise.race([check.run(context), delay(check.budgetMs ?? 120_000).then(() => { throw new Error(`no result within ${(check.budgetMs ?? 120_000) / 1000} s`); })]);
        if (outcome) row(check.id, outcome.result, outcome.fact);
      } catch (error) {
        row(check.id, "fail", error instanceof Error ? error.message.split("\n")[0] : String(error));
        await page.screenshot({ path: path.join(dirs.shots, `${check.id}-failure.png`) }).catch(() => undefined);
      }
      (report.timings ??= {})[check.id] = Date.now() - started;
    }

    // Egress: everything the run asked the guard for, and no socket beyond loopback in any process of the run.
    const processes = await runProcesses(roots, runDir);
    const sockets = await runSockets(processes.map(entry => entry.pid));
    const foreign = foreignSockets(sockets);
    report.egress = egress.attempts;
    const refused = egress.refused();
    row("egress", foreign.length ? "fail" : "pass", `${egress.attempts.filter(attempt => attempt.outcome === "tunnelled").length} tunnel(s) to Alpha, WorkOS and GitHub; `
      + `${refused.length} destination(s) refused${refused.length ? ` (${refused.slice(0, 6).join(", ")})` : ""}; ${foreign.length} socket(s) beyond loopback outside the guard`);
  } catch (error) {
    row("setup", "fail", error instanceof Error ? error.message.split("\n")[0] : String(error));
    await page?.screenshot({ path: path.join(dirs.shots, "setup-failure.png") }).catch(() => undefined);
  }
  clearTimeout(deadline);
  await teardown("end of run");
  // The account back as it was, and nothing of the run left: the rehearsal's own clean-up and inventory.
  const { runId } = await readState();
  // Development aid: ZEROS_NATIVE_ALPHA_KEEP_ACCOUNT=1 keeps the account set up for the next run; --cleanup puts it back.
  if (runId && process.env.ZEROS_NATIVE_ALPHA_KEEP_ACCOUNT === "1") row("account clean-up", "n/a", `kept for the next run (ZEROS_NATIVE_ALPHA_KEEP_ACCOUNT); --cleanup puts run ${runId.slice(0, 8)} back`);
  else if (runId) {
    const cleanupStarted = Date.now();
    let out = await rehearse(["all", "--cleanup", "--run", runId], account);
    // The rehearsal's clean-up is idempotent: one leftover it could not remove the first time is tried once more.
    if (!inventoryClean(out)) out = await rehearse(["all", "--cleanup", "--run", runId], account);
    (report.timings ??= {})["account clean-up"] = Date.now() - cleanupStarted;
    const clean = inventoryClean(out);
    row("account clean-up", clean ? "pass" : "fail", `the rehearsal's clean-up of run ${runId.slice(0, 8)}: ${clean ? "inventory clean (Pro, GitHub sign-in and agent logins put back; nothing left)" : out.split("\n").filter(line => /inventory|failed/.test(line)).slice(-4).join("; ")}`);
    if (clean) await writeState({ cleanedUp: true });
  }
  finish(rows, runDir, report, rows.some(entry => entry.result === "fail") ? 1 : 0);
}

async function hold(context) {
  const script = path.join(context.root, "eval.mjs"), out = path.join(context.root, "eval.out");
  say(`holding: write ${script}; results in ${out}`);
  for (let version = 0; ; version++) {
    let source;
    while (!(source = await fs.readFile(script, "utf8").catch(() => null))) await delay(500);
    await fs.rm(script, { force: true });
    if (source.trim() === "stop") return;
    const file = path.join(context.root, `eval-${version}.mjs`);
    await fs.writeFile(file, source);
    let result;
    try { result = await (await import(file)).default(context); } catch (error) { result = `error: ${error instanceof Error ? error.stack : String(error)}`; }
    await context.page.screenshot({ path: path.join(context.root, "eval.png") }).catch(() => undefined);
    await fs.writeFile(out, typeof result === "string" ? result : JSON.stringify(result, null, 2));
  }
}

let finished = false;
function finish(rows, runDir, report, code) {
  if (finished) return;
  finished = true;
  const { text } = table(rows, { root, home: realHome });
  say(text);
  // How long each step took, as the rehearsal prints its timings.
  const timings = Object.entries(report.timings ?? {}), total = timings.reduce((sum, [, ms]) => sum + ms, 0);
  if (timings.length) {
    say("\nTimings:");
    for (const [check, ms] of timings) say(`  ${check.padEnd(28)} ${(ms / 1000).toFixed(1).padStart(7)}s ${String(Math.round(ms * 100 / Math.max(total, 1))).padStart(3)}%`);
  }
  say("\nStill for a person to look at:");
  for (const item of PERSON_MUST_LOOK) say(`- ${item}`);
  void fs.writeFile(path.join(runDir, "report.json"), scrub(JSON.stringify(report, null, 2), { root, home: realHome })).finally(() => process.exit(code));
}

async function cleanup() {
  const stopped = await killRun([], root);
  const state = await readState();
  if (state.sessionId) {
    const status = await revokeSession(state.sessionId, agentEnv().WORKOS_ALPHA_API_KEY).catch(() => "network");
    say(`revoked the session a run left: http ${status}`);
  }
  if (state.runId && !state.cleanedUp) {
    const out = await rehearse(["all", "--cleanup", "--run", state.runId], state.account ?? accountNumber(process.env.ZEROS_NATIVE_ALPHA_ACCOUNT ?? "9"));
    say(`the rehearsal's clean-up of run ${state.runId.slice(0, 8)}: ${inventoryClean(out) ? "inventory clean" : "NOT clean; the temp folder is kept so it can be run again"}`);
    if (!inventoryClean(out)) { say(out); return; }
  }
  await fs.rm(root, { recursive: true, force: true });
  say(`stopped ${stopped.stopped} process(es); removed the temp folder`);
  const gitDir = (await run("git", ["rev-parse", "--git-dir"]).catch(() => "")).trim();
  const common = (await run("git", ["rev-parse", "--git-common-dir"]).catch(() => "")).trim();
  const top = (await run("git", ["rev-parse", "--show-toplevel"]).catch(() => "")).trim();
  const tmp = await fs.realpath(os.tmpdir());
  const realTop = top ? await fs.realpath(top).catch(() => top) : "";
  const removal = worktreeRemoval({ repo, gitDir, common, realTop, tmp });
  if (removal) {
    for (const command of removal.commands) await run("git", command.args, { cwd: command.cwd });
    say("removed this worktree (git worktree remove, then prune)");
  } else say("left the checkout alone: it is not a linked worktree under the temp directory");
}

if (mode === "--build") await build();
else if (mode === "--run") await runCheck();
else if (mode === "--cleanup") await cleanup();
else { say("Usage: node scripts/native-alpha-check.mjs --build | --run | --cleanup"); process.exit(2); }
