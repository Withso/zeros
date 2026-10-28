#!/usr/bin/env node
// Run native Design qualification from a Mac terminal. Source and dependencies
// are read from this checkout; each run owns its builds, fixtures and profile.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localEnvironment, runOwnedProcess } from "./electron-local.mjs";

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = path.join(repo, ".context", "design-native");
const defaultStages = ["host", "product", "engine"];
const stageNames = [...defaultStages, "performance", "owners"];

export function nativeProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}

/** Inspect argv only to identify qualification processes. Never retain or
 * print the table, which can contain unrelated command-line credentials. */
export function nativeQualificationProcesses(table, ownPid = process.pid) {
  const rows = table.trim().split("\n").flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), stat: match[3], command: match[4] }] : [];
  });
  const ancestors = new Set([ownPid]);
  let parent = rows.find(row => row.pid === ownPid)?.ppid;
  while (parent && !ancestors.has(parent)) {
    ancestors.add(parent);
    parent = rows.find(row => row.pid === parent)?.ppid;
  }
  const script = /(?:^|[/\s])(?:design-native-(?:run|product|performance|owners)\.mjs|native-qualification-worker(?:-v\d+)?\.mjs|native-product-qualification(?:-v\d+)?\.mjs|native-qualification(?:-v\d+)?\.cjs)(?:[\s"']|$)/;
  const fixture = /\.context\/(?:design-native\/|native-design-app-|design-performance-continuation\/native-host-profile)/;
  return rows.filter(row => !ancestors.has(row.pid) && !row.stat.startsWith("Z") &&
    (script.test(row.command) || fixture.test(row.command)))
    .map(({ pid, ppid }) => ({ pid, ppid }));
}

function readSmallJson(file, maxBytes = 256 * 1024) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes)
    throw new Error("Qualification metadata must be a bounded regular file.");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function readNativeReportJson(file) {
  // Measurements retain per-process samples across both render paths and
  // twenty switches. They are larger than lock/status markers, but still
  // bounded regular files; never relax the marker reader for recovery.
  return readSmallJson(file, 4 * 1024 * 1024);
}

export function writeNativeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const json = `${JSON.stringify(value, null, 2)}\n`;
  // Own the file before installing cleanup. A short write (including ENOSPC)
  // must retire its partial file and descriptor, while an exclusive-open
  // collision must never remove another writer's file.
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try { fs.writeFileSync(fd, json); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  }
  finally { fs.rmSync(temporary, { force: true }); }
}

/** The caller also checks for surviving qualification children before taking
 * this lock. An incomplete or ambiguous owner fails closed. */
export function acquireNativeRunLock(root, runId, alive = nativeProcessAlive) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, "run.lock");
  const token = randomUUID();
  const value = { pid: process.pid, token, runId, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = path.join(root, `lock-${token}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      fs.linkSync(temporary, file);
      return () => {
        if (readSmallJson(file).token === token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally { fs.rmSync(temporary, { force: true }); }
    const previous = readSmallJson(file);
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0 ||
        typeof previous.token !== "string" || !/^[a-f0-9-]{36}$/.test(previous.token))
      throw new Error("Invalid qualification lock; inspect it before recovery.");
    if (alive(previous.pid) !== false)
      throw new Error(`Native qualification may still be running (PID ${previous.pid}). Use --status.`);
    const recovery = path.join(root, "recovery.lock");
    const fd = fs.openSync(recovery, "wx", 0o600);
    try {
      if (readSmallJson(file).token !== previous.token) continue;
      if (alive(previous.pid) !== false) throw new Error("Previous qualification owner is still alive.");
      const archive = path.join(root, `abandoned-lock-${previous.token}.json`);
      fs.writeFileSync(archive, JSON.stringify(previous, null, 2), { flag: "wx", mode: 0o600 });
      fs.unlinkSync(file);
    } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
  }
  throw new Error("Another qualification launcher acquired the checkout.");
}

export function collectNativeSourceManifest(root) {
  const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"],
    { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  if (fs.realpathSync(gitRoot) !== fs.realpathSync(root))
    throw new Error("Collect source inputs at the checkout root; projections require an explicit file manifest.");
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    "apps", "packages", "styles", "scripts", "resources", "catalogs", "patches", "types", ":(top,glob)*"],
  { cwd: root, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  const files = [...new Set(listed.split("\0").filter(Boolean))].sort().map(file => ({
    file, sha256: fs.existsSync(path.join(root, file))
      ? createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex") : null,
  }));
  return { files, digest: createHash("sha256").update(JSON.stringify(files)).digest("hex") };
}

export function acceptNativeHostReport(stage, report) {
  if (stage.exitCode !== 0 || stage.cancelled || stage.timedOut || report.platform !== "darwin" ||
      !Array.isArray(report.checks) || !report.checks.length ||
      !(Date.parse(report.checkedAt) >= Date.parse(stage.startedAt)) ||
      !(Date.parse(report.checkedAt) <= Date.parse(stage.finishedAt)))
    throw new Error("Native host did not produce a successful fresh macOS report.");
  return report.checks.length;
}

/** A timed-out v4 request may still arrive late. Claim its exclusive marker
 * before starting the replacement; never overwrite an earlier run's marker. */
export function fenceLegacyNativeLaunch(root, runId) {
  const directory = path.join(root, ".context", "design-performance-continuation");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.realpathSync(directory).startsWith(fs.realpathSync(root) + path.sep))
    throw new Error("Legacy qualification directory leaves the checkout.");
  const file = path.join(directory, "native-v4-launch.json");
  const marker = { status: "superseded", replacement: "design-native-run", runId, at: new Date().toISOString() };
  try { fs.writeFileSync(file, JSON.stringify(marker, null, 2), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const previous = readSmallJson(file);
    if (previous.status !== "superseded" || previous.replacement !== "design-native-run")
      throw new Error("A v4 launch marker appeared. Recover that run before starting another.");
  }
}

function status() {
  try {
    const latest = readSmallJson(path.join(evidenceRoot, "latest.json"));
    if (!/^[a-zA-Z0-9-]+$/.test(latest.runId)) throw new Error("Invalid run identity.");
    const root = path.join(evidenceRoot, latest.runId);
    const report = readSmallJson(path.join(root, "status.json"));
    console.log(JSON.stringify({ ...report, alive: nativeProcessAlive(report.pid) }, null, 2));
    for (const file of ["product-status.json", "product-report.json", "performance-status.json", "performance-report.json", "owners-status.json", "owners-report.json"]) {
      try {
        const product = file.endsWith("-report.json") ? readNativeReportJson(path.join(root, file)) : readSmallJson(path.join(root, file));
        console.log(JSON.stringify({ file, stage: product.stage, checks: product.checks?.length,
          failures: product.failures, finishedAt: product.finishedAt }));
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    console.log("No native qualification run is recorded by this launcher.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--status") return status();
  if (args.length === 1 && args[0] === "--help") {
    console.log("node scripts/design-native-run.mjs [--recover-v4] [--stage host|product|engine|performance|owners] [--source-digest SHA256] [--reference-root ISOLATED_CHECKOUT]\nnode scripts/design-native-run.mjs --status");
    return;
  }
  let selected = defaultStages, expected, referenceRoot, recoverV4 = false;
  while (args.length) {
    const option = args.shift();
    if (option === "--recover-v4") { recoverV4 = true; continue; }
    const value = args.shift();
    if (option === "--stage" && stageNames.includes(value)) selected = [value];
    else if (option === "--source-digest" && /^[a-f0-9]{64}$/.test(value ?? "")) expected = value;
    else if (option === "--reference-root" && value) referenceRoot = path.resolve(value);
    else throw new Error("Invalid qualification arguments. Use --help.");
  }
  if (referenceRoot && (selected.length !== 1 || selected[0] !== "performance"))
    throw new Error("--reference-root requires --stage performance.");
  assert(process.platform === "darwin", "Native qualification requires macOS; no native check ran.");
  const processes = nativeQualificationProcesses(execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="],
    { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 }));
  assert(!processes.length, `An existing qualification process needs recovery: ${JSON.stringify(processes)}`);
  const source = collectNativeSourceManifest(repo);
  if (expected) assert.equal(source.digest, expected, "Checkout source differs from the verified launcher inputs. Let source sync finish before running.");
  const runId = `${new Date().toISOString().replace(/[^0-9T]/g, "")}-${randomUUID().slice(0, 8)}`;
  const release = acquireNativeRunLock(evidenceRoot, runId);
  const root = path.join(evidenceRoot, runId);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  const report = { runId, pid: process.pid, platform: process.platform, arch: process.arch,
    startedAt: new Date().toISOString(), sourceDigest: source.digest, selectedStages: selected, stages: [],
    limitations: [selected.includes("performance")
      ? "The performance stage records controlled native workloads; results require review against acceptance targets."
      : "This run does not establish a before/after performance comparison or complete performance acceptance.",
      "Product fixtures cover Personal Local. Retained organization-owned Local needs separate compatibility qualification."] };
  const save = () => writeNativeJson(path.join(root, "status.json"), report);
  try {
    fs.mkdirSync(root, { mode: 0o700 });
    if (recoverV4) fenceLegacyNativeLaunch(repo, runId);
    writeNativeJson(path.join(root, "sources.json"), source);
    report.revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 5000 }).trim();
    save();
    writeNativeJson(path.join(evidenceRoot, "latest.json"), { runId });
    console.log(`Native qualification: ${path.relative(repo, root)}\nSource digest: ${source.digest}`);
    const env = { ...localEnvironment({ identity: { slug: `design-qual-${runId.slice(-8)}`, name: "Zeros Design Qualification" },
      vitePort: 6998, engineBase: 39980 }), ZEROS_ISOLATE: "1", ZEROS_DATA_DIR: path.join(root, "worker-profile") };
    const run = async (name, command, argv, cwd = repo) => {
      const row = { name, startedAt: new Date().toISOString(), running: true };
      report.stages.push(row); save();
      console.log(`START ${name}`);
      const log = fs.openSync(path.join(root, `${name}.log`), "wx", 0o600);
      const stageController = new AbortController();
      let tail = "";
      const stop = () => stageController.abort();
      controller.signal.addEventListener("abort", stop, { once: true });
      const timeout = setTimeout(() => { row.timedOut = true; stop(); }, 17 * 60_000);
      try {
        if (controller.signal.aborted) stop();
        const result = await runOwnedProcess(command, argv, { cwd, env, signal: stageController.signal,
          killGraceMs: 15_000, output: chunk => {
            tail = (tail + chunk).slice(-4000); fs.writeSync(log, chunk); process.stdout.write(chunk);
          } });
        row.cancelled = result.cancelled;
        row.exitCode = row.timedOut ? 124 : result.cancelled ? 130 : result.code;
      } catch (error) { row.exitCode = 1; row.error = error.message; }
      finally {
        clearTimeout(timeout); controller.signal.removeEventListener("abort", stop); fs.closeSync(log);
        if (row.exitCode !== 0) row.failureExcerpt = tail;
        row.running = false; row.finishedAt = new Date().toISOString(); save();
        console.log(`END ${name}: exit ${row.exitCode}`);
      }
      return row;
    };
    if (selected.includes("host")) {
      const { build } = await import("esbuild");
      const host = path.join(root, "host"); fs.mkdirSync(host);
      const bundle = path.join(host, "native-qualification.cjs");
      await build({ absWorkingDir: repo, entryPoints: ["scripts/design-native-qualification.ts"], outfile: bundle,
        bundle: true, platform: "node", format: "cjs", external: ["electron"], logLevel: "silent" });
      const row = await run("host", require("electron"), [bundle, `--user-data-dir=${path.join(host, "profile")}`], host);
      try {
        const result = readSmallJson(path.join(host, ".context", "design-native-qualification.json"));
        row.checks = acceptNativeHostReport(row, result); row.reportAccepted = true;
        writeNativeJson(path.join(root, "host-report.json"), result);
      } catch (error) { row.reportAccepted = false; row.error = error.message; }
      save();
    }
    if (!controller.signal.aborted && selected.includes("product")) {
      const row = await run("product", process.execPath, [path.join(repo, "scripts/design-native-product.mjs"), root]);
      try {
        const result = readNativeReportJson(path.join(root, "product-report.json"));
        row.failures = result.failures;
        assert(Array.isArray(result.failures) && !result.failures.length && result.sourceDigest === source.digest,
          "Product qualification did not produce a successful report for these sources.");
        row.checks = acceptNativeHostReport(row, { ...result, checkedAt: result.finishedAt });
        row.reportAccepted = true;
      } catch (error) { row.reportAccepted = false; row.error = error.message; }
      save();
    }
    if (!controller.signal.aborted && selected.includes("performance")) {
      const row = await run("performance", process.execPath, [path.join(repo, "scripts/design-native-performance.mjs"), root,
        ...(referenceRoot ? [referenceRoot] : [])]);
      try {
        const result = readNativeReportJson(path.join(root, "performance-report.json"));
        assert(Array.isArray(result.failures) && !result.failures.length && result.sourceDigest === source.digest,
          "Performance qualification did not produce a successful report for these sources.");
        row.checks = acceptNativeHostReport(row, { ...result, checkedAt: result.finishedAt });
        row.reportAccepted = true;
      } catch (error) { row.reportAccepted = false; row.error = error.message; }
      save();
    }
    if (!controller.signal.aborted && selected.includes("owners")) {
      const row = await run("owners", process.execPath, [path.join(repo, "scripts/design-native-owners.mjs"), root]);
      try {
        const result = readNativeReportJson(path.join(root, "owners-report.json"));
        assert(Array.isArray(result.failures) && !result.failures.length && result.sourceDigest === source.digest,
          "Owner qualification did not produce a successful report for these sources.");
        row.checks = acceptNativeHostReport(row, { ...result, checkedAt: result.finishedAt });
        row.reportAccepted = true;
      } catch (error) { row.reportAccepted = false; row.error = error.message; }
      save();
    }
    if (!controller.signal.aborted && selected.includes("engine")) {
      const stage = path.join(root, "engine"); fs.mkdirSync(stage); fs.mkdirSync(path.join(stage, "scripts"));
      for (const name of ["apps", "packages", "node_modules"]) fs.symlinkSync(path.join(repo, name), path.join(stage, name), "dir");
      for (const name of ["package.json", "tsconfig.json"]) fs.copyFileSync(path.join(repo, name), path.join(stage, name));
      for (const name of ["build-sidecar.mjs", "smoke-engine.mjs"])
        fs.copyFileSync(path.join(repo, "scripts", name), path.join(stage, "scripts", name));
      const built = await run("engine-build", process.execPath, [path.join(stage, "scripts/build-sidecar.mjs")], stage);
      if (built.exitCode === 0 && !controller.signal.aborted)
        await run("engine-smoke", process.execPath, [path.join(stage, "scripts/smoke-engine.mjs")], stage);
    }
    report.sourceUnchanged = collectNativeSourceManifest(repo).digest === source.digest;
    report.passed = !controller.signal.aborted && report.sourceUnchanged && report.stages.length > 0 &&
      report.stages.every(row => row.exitCode === 0 && row.reportAccepted !== false);
    if (!report.passed) process.exitCode = 1;
  } catch (error) { report.error = error.stack ?? String(error); report.passed = false; process.exitCode = 1; }
  finally {
    report.finishedAt = new Date().toISOString();
    if (fs.existsSync(root)) save();
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); release();
    console.log(`NATIVE_RESULT ${JSON.stringify(report)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
