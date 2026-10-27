// Retained organization-owned Local compatibility, using ordinary Dev auth.
// Owns a fresh instance profile; never copies or serializes account credentials.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchNativeElectron } from "./design-native-electron.mjs";
import { waitForNativeOwnerAccess } from "./design-native-owner-access.mjs";
import { localEnvironment, pickLocalPorts } from "./electron-local.mjs";
import { ensureDevAuthEnvironment } from "./dev-auth-profile.mjs";
import { collectNativeSourceManifest, nativeProcessAlive, writeNativeJson } from "./design-native-run.mjs";
import { nativeProcessSample } from "./design-native-baseline.mjs";
import { waitForNativeRenderer } from "./design-native-renderer.mjs";
import { activateNativeWorkbenchTab } from "./design-native-workbench.mjs";
import { prepareNativeDesignView, selectNativeDesignFrame, readNativeDesignProvenance, nativeDesignHiddenResourcesRetired } from "./design-native-view.mjs";
import { nativeViteConfiguration } from "./design-native-vite.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidence = path.resolve(process.argv[2] ?? ".");
assert.equal(process.platform, "darwin", "Owner qualification requires macOS.");
assert.equal(path.dirname(evidence), path.join(repo, ".context", "design-native"));
const lock = JSON.parse(await fs.readFile(path.join(path.dirname(evidence), "run.lock"), "utf8"));
assert(lock.pid === process.ppid && lock.runId === path.basename(evidence), "Use the owning qualification runner.");
const root = await fs.mkdtemp(path.join(evidence, "owners-"));
const report = { platform: process.platform, startedAt: new Date().toISOString(),
  sourceDigest: collectNativeSourceManifest(repo).digest, artifacts: root, checks: [], failures: [], switches: [], captures: [],
  limitations: ["Disposable retained Local rows, not new organization-local creation.",
    "Normal Alpha Dev authorization; no cloud VM is created and cloud Design remains unavailable.",
    "Naturally settled per-process samples, not a before/after or total-private-memory benchmark."] };
const save = () => writeNativeJson(path.join(evidence, "owners-report.json"), report);
const status = stage => { writeNativeJson(path.join(evidence, "owners-status.json"), { pid: process.pid, stage, at: new Date().toISOString() }); console.log(`OWNERS_STAGE ${stage}`); save(); };
const check = (name, condition) => { assert(condition, name); report.checks.push(name); console.log(`PASS ${name}`); };
const run = async (command, args, options = {}) => (await exec(command, args, { cwd: repo, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options })).stdout;
let app, page, vite, viteLog, enginePid;
const deadline = setTimeout(() => { console.error("Native owner qualification deadline exceeded"); void app?.close().finally(() => process.exit(124)); if (!app) process.exit(124); }, 12 * 60_000);
const closeApp = async () => {
  await app?.close(); app = undefined; page = undefined;
  const until = Date.now() + 15_000;
  while (enginePid && nativeProcessAlive(enginePid) !== false && Date.now() < until) await delay(100);
  assert(!enginePid || nativeProcessAlive(enginePid) === false, "The task's engine must exit before its database can be seeded.");
  enginePid = undefined;
};
try {
  status("preparing-normal-dev");
  const identity = { slug: `design-owner-${randomUUID().slice(0, 12)}`, name: "Zeros Owner Compatibility" };
  const ports = await pickLocalPorts(identity.slug);
  // Start with the launcher's sanitized environment, then select ordinary Dev.
  const env = localEnvironment({ identity, ...ports });
  for (const name of ["ZEROS_LOCAL_DEVELOPMENT", "ZEROS_ISOLATE", "ZEROS_DATA_DIR", "ZEROS_SHARED_SECRETS_DIR"]) delete env[name];
  const auth = await ensureDevAuthEnvironment({ processEnv: {} });
  assert.equal(auth.issue, null, "A validated public Alpha Dev auth configuration is required.");
  Object.assign(env, auth.env, { ZEROS_NO_ENGINE_HMR: "1", ZEROS_NO_MAIN_HMR: "1", ELECTRON_RENDERER_URL: `http://127.0.0.1:${ports.vitePort}` });
  const profile = path.join(os.homedir(), "Library", "Application Support", `com.zeros.dev.${identity.slug}`);
  // Exclusive creation proves this is a task-owned instance, not a real profile.
  await fs.mkdir(profile, { mode: 0o700 });
  writeNativeJson(path.join(profile, "design-qualification-owner.json"), { runId: lock.runId, artifacts: root });
  report.profile = profile;
  const stage = path.join(root, "app"); await fs.mkdir(stage);
  for (const directory of ["node_modules", "apps", "packages", "resources", "styles"]) {
    try { await fs.access(path.join(repo, directory)); await fs.symlink(path.join(repo, directory), path.join(stage, directory), "dir"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await fs.copyFile(path.join(repo, "package.json"), path.join(stage, "package.json"));
  await fs.writeFile(path.join(root, "main-build.log"), await run("pnpm", ["exec", "tsup", "--config", "apps/desktop/electron/tsup.config.ts", "--out-dir", path.join(stage, "dist-electron"), "--metafile"], { env }));
  const config = path.join(root, "vite.config.mjs");
  await fs.writeFile(config, nativeViteConfiguration(repo, path.join(root, "vite-cache")));
  viteLog = await fs.open(path.join(root, "vite.log"), "w");
  vite = spawn(process.execPath, [path.join(repo, "node_modules/vite/bin/vite.js"), "--config", config, "--host", "127.0.0.1", "--port", String(ports.vitePort), "--strictPort"], { cwd: repo, env, stdio: ["ignore", viteLog.fd, viteLog.fd] });
  const readyBy = Date.now() + 60_000;
  while (!(await fetch(env.ELECTRON_RENDERER_URL).then(response => response.ok, () => false))) {
    assert(Date.now() < readyBy, "Owner qualification Vite did not start."); await delay(100);
  }
  const launch = async () => {
    app = await launchNativeElectron({ args: [stage], cwd: root, env, timeout: 90_000 });
    page = await app.firstWindow({ timeout: 60_000 }); page.setDefaultTimeout(30_000);
    await page.waitForFunction(() => globalThis.window.__ZEROS_NATIVE__?.localDevelopment === false);
    report.runtime = await app.evaluate(({ app }) => ({ mainPid: process.pid, userData: app.getPath("userData"), name: app.getName(), electron: process.versions.electron, chromium: process.versions.chrome,
      mockKeychain: app.commandLine.hasSwitch("use-mock-keychain"), backgroundTimersDisabled: app.commandLine.hasSwitch("disable-background-timer-throttling") }));
    assert.equal(report.runtime.userData, profile);
    assert(!report.runtime.mockKeychain && !report.runtime.backgroundTimersDisabled, "Qualification requires ordinary native Keychain and background scheduling.");
    status("checking-normal-membership");
    const membership = await waitForNativeOwnerAccess(page);
    report.authorization = { signedIn: membership.signedIn, confirmedOrganization: Boolean(membership.organizationId), method: "Normal shared Dev sign-in and authenticated /v1/me" };
    if (membership.blocked) { report.blocked = membership.blocked; throw new Error(membership.blocked); }
    const rows = (await run("ps", ["-axo", "pid=,ppid=,comm="])).trim().split("\n").map(row => row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
    const engines = rows.filter(row => Number(row[2]) === report.runtime.mainPid && /(?:^|\/)bun$/.test(row[3]));
    assert.equal(engines.length, 1, "Identify the task-owned source engine."); enginePid = Number(engines[0][1]);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setBounds({ x: 0, y: 40, width: 1440, height: 1000 }); window.show(); });
    return membership;
  };
  const membership = await launch();
  await closeApp();
  status("preparing-retained-owner-fixture");
  const fixtureRoot = path.join(root, "fixture");
  await run("bun", ["scripts/design-owner-compatibility-fixture.ts", "--output", fixtureRoot, "--organization-id", membership.organizationId], { env });
  const fixture = JSON.parse(await fs.readFile(path.join(fixtureRoot, "fixture.json"), "utf8"));
  report.fixture = path.join(fixtureRoot, "fixture.json");
  const ownership = JSON.parse(await fs.readFile(path.join(profile, "design-qualification-owner.json"), "utf8"));
  assert.equal(ownership.runId, lock.runId);
  // Archive only this task's stopped, empty auth-probe database. The account
  // store remains in the primary Dev directory, accessed by ordinary main code.
  for (const name of ["zeros.db", "zeros.db-wal", "zeros.db-shm"]) {
    await fs.rename(path.join(profile, name), path.join(profile, `${name}.auth-probe`)).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
  await fs.copyFile(path.join(fixture.profile, "zeros.db"), path.join(profile, "zeros.db"));
  await launch();
  await page.evaluate(async () => { await (await import("/apps/desktop/src/renderer/features/team/team-store.ts")).refreshTeams(); });
  check("Retained owner fixtures use a separate ordinary Dev profile", report.runtime.userData === profile);
  const open = async workspace => {
    await page.evaluate(async workspace => {
      const { getTeamStoreState } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
      if (workspace.organizationId && !(getTeamStoreState().me?.organizations ?? getTeamStoreState().me?.teams ?? []).some(owner => owner.id === workspace.organizationId && !owner.isPersonal))
        throw new Error("The selected fixture owner no longer has normal membership.");
      const { setActiveOrganizationSelection } = await import("/apps/desktop/src/renderer/features/team/active-team.ts");
      setActiveOrganizationSelection(workspace.organizationId ?? "local-personal", !workspace.organizationId);
    }, workspace);
    await waitForNativeRenderer(page, async workspace => {
      const { getActiveOrganizationSnapshot } = await import("/apps/desktop/src/renderer/features/team/team-store.ts");
      const active = getActiveOrganizationSnapshot();
      return active?.id === (workspace.organizationId ?? "local-personal");
    }, workspace);
    await page.evaluate(async workspace => {
      const { useWorkspaceStore } = await import("/apps/desktop/src/renderer/state/workspace-store.ts");
      useWorkspaceStore.getState().dispatch({ type: "OPEN_WORKSPACE", folder: workspace.path, repoRoot: workspace.repoRoot, chatId: null });
    }, workspace);
    await activateNativeWorkbenchTab(page, workspace.path, "design");
    const owner = page.locator(`[data-design-retained-workspace="${workspace.id}"][aria-hidden="false"]`);
    await owner.locator("[data-design-canvas-viewport]").waitFor();
    await prepareNativeDesignView(page, workspace.id, { zoom: 0.5, panX: 24, panY: 72 });
    const readyBy = Date.now() + 30_000;
    while (true) {
      const source = await readNativeDesignProvenance(page, { workspaceId: workspace.id, file: workspace.frames[0] });
      if (source.nativeDocuments + source.nativeVectors > 0) break;
      assert(Date.now() < readyBy, "The exact owner's authenticated Design source did not appear.");
      await delay(100);
    }
    await delay(2000);
    assert.equal(await page.locator('[data-design-retained-workspace][aria-hidden="false"]').getAttribute("data-design-retained-workspace"), workspace.id);
    return owner;
  };
  const snapshot = async () => ({ at: new Date().toISOString(),
    resources: await page.evaluate(async () => (await import("/apps/desktop/src/renderer/features/design-workspace/state/design-renderer-resources.ts")).designRendererResources()),
    native: [...await app.evaluate(({ app }) => app.getAppMetrics().map(({ pid, type, cpu, memory }) => ({ pid, role: type, cpuSeconds: cpu.cumulativeCPUUsage, cpuSource: "electron", rssBytes: memory.workingSetSize * 1024 }))),
      { ...await nativeProcessSample(enginePid), role: "local-engine" }] });
  // Warm both owners before counting twenty actual, naturally settled switches.
  for (const workspace of fixture.workspaces) await open(workspace);
  await open(fixture.workspaces[0]);
  report.warm = await snapshot();
  for (let index = 0; index < 20; index++) {
    const workspace = fixture.workspaces[index % 2 ? 0 : 1];
    status(`switch-${index + 1}-${workspace.fixtureOwner}`);
    await open(workspace);
    report.switches.push({ visit: index + 1, owner: workspace.fixtureOwner, workspaceId: workspace.id, ...await snapshot() }); save();
  }
  check("Twenty settled owner and workspace switches show the exact authored owner", report.switches.length === 20);
  for (const workspace of fixture.workspaces) {
    status(`capture-${workspace.fixtureOwner}`); await open(workspace);
    await selectNativeDesignFrame(page, workspace.id, workspace.frames[0]);
    // Inspect authored text when the workload explicitly opens an editor for
    // capture, rather than forcing 20 passive visits to allocate one.
    await page.locator(`[data-design-retained-workspace="${workspace.id}"][aria-hidden="false"] [data-design-frame=${JSON.stringify(workspace.frames[0])}] iframe[data-design-document-buffer="displayed"][data-design-document-ready]`)
      .contentFrame().getByText(workspace.marker, { exact: true }).waitFor();
    check(`${workspace.fixtureOwner}: native document preserves the authored owner marker`, true);
    const capture = await page.evaluate(async workspace => {
      const { designFrameRuntime } = await import("/apps/desktop/src/renderer/platform/bridge/design-frame-runtime.ts");
      const runtime = designFrameRuntime(workspace.id, workspace.frames[0]);
      if (!runtime) throw new Error("The selected owner has no native runtime.");
      return runtime.captureScreenshot(null, 1);
    }, workspace);
    const png = Buffer.from(capture.dataUrl.split(",")[1], "base64");
    await fs.writeFile(path.join(root, `${workspace.fixtureOwner}.png`), png);
    // Decode through canvas for standardized RGBA; nativeImage bitmap channel
    // ordering is platform-dependent. Check pixels outside short BODY content.
    const decoded = await page.evaluate(async dataUrl => {
      const image = new Image();
      const canvas = document.createElement("canvas");
      try {
        image.src = dataUrl; await image.decode();
        canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("PNG pixel inspection is unavailable.");
        context.drawImage(image, 0, 0);
        return { width: canvas.width, height: canvas.height,
          background: Array.from(context.getImageData(10, canvas.height - 10, 1, 1).data) };
      } finally { image.src = ""; canvas.width = 0; canvas.height = 0; }
    }, capture.dataUrl);
    report.captures.push({ owner: workspace.fixtureOwner, ...decoded }); save();
    check(`${workspace.fixtureOwner}: native capture preserves the CSS viewport`, capture.width === 560 && capture.height === 360 && decoded.width === 560 && decoded.height === 360);
    check(`${workspace.fixtureOwner}: native capture preserves the authored background below short content`, decoded.background.every((value, index) => value === [250, 250, 250, 255][index]));
    await activateNativeWorkbenchTab(page, workspace.path, "files"); await delay(12_000);
    const hidden = await snapshot(); report[`${workspace.fixtureOwner}Hidden`] = hidden;
    check(`${workspace.fixtureOwner}: hidden documents and capture work retire with bounded warm caches`, nativeDesignHiddenResourcesRetired(hidden.resources));
  }
  status("restart"); await closeApp(); await launch();
  await page.evaluate(async () => { await (await import("/apps/desktop/src/renderer/features/team/team-store.ts")).refreshTeams(); });
  for (const workspace of fixture.workspaces) {
    await open(workspace);
    for (const source of workspace.sources) {
      assert.equal(createHash("sha256").update(await fs.readFile(path.join(workspace.path, source.file))).digest("hex"), source.sha256, "Authored fixture bytes changed.");
    }
  }
  check("Both retained owners reopen after restart with unchanged authored files", true);
  check("Owner qualification source inputs remain unchanged", collectNativeSourceManifest(repo).digest === report.sourceDigest);
} catch (error) {
  // These controlled errors have no session or response bodies. Do not collect
  // arbitrary renderer text/screenshots from the normal signed-in account UI.
  report.failures.push(error.stack ?? String(error)); process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await closeApp().catch(error => { report.failures.push(`App close: ${error.message}`); process.exitCode = 1; });
  vite?.kill("SIGTERM"); await viteLog?.close();
  report.finishedAt = new Date().toISOString(); status(report.failures.length ? (report.blocked ? "blocked" : "failed") : "complete");
}
