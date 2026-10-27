// Read-only sampling of an already opened, isolated native Design fixture.
// The CDP endpoint must belong to the exact Electron build under qualification.
import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readNativeDesignProvenance } from "./design-native-view.mjs";

const exec = promisify(execFile);

export function nativeDesignEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("Use an HTTP CDP endpoint on a loopback IP, with no credentials or extra path.");
  return url.origin;
}

export function nativeCpuSeconds(value) {
  const match = value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const days = Number(match[1] ?? 0), hours = Number(match[2] ?? 0);
  const minutes = Number(match[3]), seconds = Number(match[4]);
  if (seconds >= 60 || (match[2] && minutes >= 60) || (match[1] && (!match[2] || hours >= 24))) return null;
  const total = days * 86400 + hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) ? total : null;
}

export async function nativeProcessSample(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid native process identity.");
  const sample = { pid: id, cpuSeconds: null, cpuSource: "ps", rssBytes: null };
  try {
    const { stdout } = await exec("ps", ["-p", String(id), "-o", "rss=,time="], { timeout: 3000 });
    const row = stdout.trim().match(/^(\d+)\s+(\S+)$/);
    if (row) {
      const kb = Number(row[1]);
      if (Number.isSafeInteger(kb * 1024)) sample.rssBytes = kb * 1024;
      sample.cpuSeconds = nativeCpuSeconds(row[2]);
    }
  } catch { /* A short-lived process may have exited; retain missing values. */ }
  return sample;
}

/** macOS MEM is the physical footprint, including GPU/IOSurface and compressed
 * allocations that can be almost absent from RSS. Match the app inspector's
 * source; a missing sample is never replaced with resident memory. */
export function parseNativePhysicalFootprints(stdout) {
  const values = new Map();
  const units = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 };
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+(?:\.\d+)?)([BKMGT])?[+-]?\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]), bytes = Math.round(Number(match[2]) * units[match[3] ?? "B"]);
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(bytes) && bytes >= 0) values.set(pid, bytes);
  }
  return values;
}

export function parseNativeOwnedFootprints(stdout, pids) {
  const report = JSON.parse(stdout), expected = new Set(pids), values = new Map(), seen = new Set();
  if (report.source !== "proc_pid_rusage" || report.version !== 1 || !Array.isArray(report.rows) || report.rows.length !== expected.size)
    throw new Error("Native physical-footprint response is incomplete.");
  for (const row of report.rows) {
    if (!expected.has(row.pid) || seen.has(row.pid)) throw new Error("Native physical-footprint identity mismatch.");
    seen.add(row.pid);
    if (row.error === null && Number.isSafeInteger(row.physicalFootprintBytes) && row.physicalFootprintBytes >= 0)
      values.set(row.pid, row.physicalFootprintBytes);
    else if (row.physicalFootprintBytes !== null || !Number.isSafeInteger(row.error) || row.error === 0)
      throw new Error("Native physical-footprint value is invalid.");
  }
  return values;
}

/** Query only the already enumerated owned PIDs. A system-wide top scan costs
 * hundreds of milliseconds of CPU and can perturb the gesture it measures.
 * libproc reads the same physical-footprint counter, with byte precision. */
export async function readNativePhysicalFootprints(pids, { run = exec, platform = process.platform } = {}) {
  if (platform !== "darwin") return new Map();
  if (!Array.isArray(pids) || !pids.length || pids.length > 2048 || new Set(pids).size !== pids.length ||
      pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || pid >= 2 ** 31))
    throw new Error("Native physical memory needs explicit owned process identities.");
  const helper = fileURLToPath(new URL("./design-native-footprint.py", import.meta.url));
  const { stdout } = await run("/usr/bin/python3", [helper, JSON.stringify(pids)], { timeout: 5000, maxBuffer: 1024 * 1024 });
  return parseNativeOwnedFootprints(stdout, pids);
}

/** An acceptance guard, not an OS allocation quota. Call while loading and
 * interacting as well as after settling; sparse final samples miss peaks. */
export function assertNativeMemoryBudget(processes, { maxGpuBytes, maxTotalBytes }) {
  if (![maxGpuBytes, maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error("Invalid native physical-memory budget.");
  const seen = new Set();
  let totalBytes = 0, gpuBytes = 0, hasGpu = false;
  for (const sample of processes) {
    if (!Number.isSafeInteger(sample.pid) || sample.pid <= 0) throw new Error("Invalid native process identity.");
    if (seen.has(sample.pid)) throw new Error("Duplicate native process sample.");
    seen.add(sample.pid);
    if (!Number.isSafeInteger(sample.physicalFootprintBytes) || sample.physicalFootprintBytes < 0)
      throw new Error("Native physical footprint is unavailable; RSS cannot establish memory acceptance.");
    totalBytes += sample.physicalFootprintBytes;
    if (sample.role?.toLowerCase() === "gpu") { hasGpu = true; gpuBytes += sample.physicalFootprintBytes; }
  }
  if (!hasGpu) throw new Error("The native GPU process is missing from memory acceptance.");
  if (gpuBytes > maxGpuBytes) throw new Error(`GPU physical footprint ${gpuBytes} exceeds the ${maxGpuBytes}-byte guard.`);
  if (totalBytes > maxTotalBytes) throw new Error(`App physical footprint ${totalBytes} exceeds the ${maxTotalBytes}-byte guard.`);
  return { gpuBytes, totalBytes };
}

export async function processMemory(processes) {
  const footprints = await readNativePhysicalFootprints(processes.map(row => row.id));
  return Promise.all(processes.map(async ({ id, type, cpuTime }) => {
    const sample = await nativeProcessSample(id);
    const physicalFootprintBytes = footprints.get(id) ?? null;
    const chromiumCpu = typeof cpuTime === "number" && Number.isFinite(cpuTime) && cpuTime >= 0;
    return { ...sample, role: type, cpuSeconds: chromiumCpu ? cpuTime : sample.cpuSeconds,
      cpuSource: chromiumCpu ? "chromium" : sample.cpuSource, physicalFootprintBytes };
  }));
}

export async function findNativeDesignFixture(browser) {
  const candidates = [];
  for (const context of browser.contexts()) for (const page of context.pages()) {
    // Native preview capture pages are disposable and may retire while CDP
    // enumerates targets. Only an observed closed page is safe to skip; errors
    // inspecting a live app page must still fail the qualification.
    if (page.isClosed()) continue;
    try {
      if (await page.locator("[data-design-canvas-viewport]:visible").count()) candidates.push(page);
    } catch (error) {
      if (!page.isClosed()) throw error;
    }
  }
  const live = candidates.filter(page => !page.isClosed());
  if (live.length !== 1) throw new Error("Open exactly one visible Local Design fixture in the qualification app.");
  return live[0];
}

export async function runNativeDesignBaseline({ endpoint, output, scenario = "idle-current-fixture", enginePid }) {
  const origin = nativeDesignEndpoint(endpoint);
  if (process.platform !== "darwin") throw new Error("Native Design qualification requires macOS; use --scaling for the browser fixture.");
  if (enginePid !== undefined && (!Number.isSafeInteger(enginePid) || enginePid <= 0))
    throw new Error("--engine-pid must identify the fixture's Local engine process.");
  const browser = await chromium.connectOverCDP(origin);
  const report = {
    recordedAt: new Date().toISOString(), scenario, platform: process.platform, architecture: process.arch,
    os: os.release(), hostMemoryBytes: os.totalmem(), cpuModel: os.cpus()[0]?.model,
    samples: [], failures: [],
    qualification: "Native Electron idle/process sampler. RSS is per process and must not be summed as private memory. No FPS, energy, or input-to-present claim. Engine memory is absent unless --engine-pid is supplied. Use dedicated fixture workspaces; this command neither navigates nor edits source.",
  };
  try {
    const session = await browser.newBrowserCDPSession();
    const version = await session.send("Browser.getVersion");
    if (!version.userAgent.includes("Electron/")) throw new Error("The endpoint is not Electron.");
    report.browser = version.product;
    report.electron = version.userAgent.match(/Electron\/([^\s]+)/)?.[1];
    const page = await findNativeDesignFixture(browser);
    const native = await readNativeDesignProvenance(page);
    if (!native.nativeDocuments && !native.nativeVectors) throw new Error("The fixture is not exercising the authenticated zeros-design protocol.");
    report.rendering = native;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Performance.enable");
    const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    for (let index = 0; index < 3; index++) {
      const before = await metrics();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const after = await metrics();
      const info = await session.send("SystemInfo.getProcessInfo");
      const processes = [...info.processInfo];
      if (enginePid && !processes.some((entry) => entry.id === enginePid))
        processes.push({ id: enginePid, type: "local-engine" });
      report.samples.push({
        seconds: after.Timestamp - before.Timestamp,
        rendererTaskSeconds: after.TaskDuration - before.TaskDuration,
        rendererScriptSeconds: after.ScriptDuration - before.ScriptDuration,
        jsHeapUsedBytes: after.JSHeapUsedSize, documents: after.Documents, nodes: after.Nodes,
        processes: await processMemory(processes),
        surfaces: await page.evaluate(() => ({
          mounted: globalThis.document.querySelectorAll("[data-design-frame]").length,
          documents: globalThis.document.querySelectorAll("[data-design-frame] iframe").length,
          incoming: globalThis.document.querySelectorAll('iframe[data-design-document-buffer="incoming"]').length,
          pictures: globalThis.document.querySelectorAll("img[data-design-frame-picture]").length,
        })),
      });
    }
    await cdp.detach();
    await session.detach();
  } catch (error) {
    report.failures.push(error.message);
    throw error;
  } finally {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    // For connectOverCDP the pinned Playwright transport's close disconnects
    // the websocket; it does not send Browser.close to the user's Electron.
    await browser.close();
  }
  console.log(`Native baseline: ${output}`);
}
