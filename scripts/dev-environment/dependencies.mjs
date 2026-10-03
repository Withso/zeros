#!/usr/bin/env node
// This module must load on a fresh checkout: only Node built-ins and other
// dependency-free modules may be imported before the three installs complete.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireWorkspaceLock, developmentHome, privateDirectory, sha256, systemEnvironment, writePrivateJson } from "./state.mjs";
import { run } from "./processes.mjs";
import { pollProvider } from "./provider-http.mjs";

const STAMP = ".zeros-dev-dependencies.json";
const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function workspacePackages(root) {
  const packages = path.join(root, "packages");
  return [".", "apps/marketing", ...(fs.existsSync(packages) ? fs.readdirSync(packages, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => `packages/${entry.name}`) : [])]
    .filter(relative => fs.existsSync(path.join(root, relative, "package.json")));
}

function dependencyGraphs(root) {
  return [
    { relative: ".", packages: workspacePackages(root), command: "pnpm", args: ["install", "--frozen-lockfile"], lock: "pnpm-lock.yaml", installedLock: ".pnpm/lock.yaml" },
    { relative: "apps/control-plane", packages: ["apps/control-plane"], command: "pnpm", args: ["--dir", "apps/control-plane", "install", "--frozen-lockfile"], lock: "pnpm-lock.yaml", installedLock: ".pnpm/lock.yaml" },
    { relative: "apps/web", packages: ["apps/web"], command: "npm", args: ["--prefix", "apps/web", "ci"], lock: "package-lock.json", installedLock: ".package-lock.json" },
  ].map(graph => ({ ...graph, directory: path.join(root, graph.relative), label: graph.relative === "." ? "root workspace" : graph.relative }));
}

function fingerprint(root, graph) {
  const files = [path.join(graph.relative, graph.lock), ...graph.packages.map(relative => path.join(relative, "package.json"))];
  const workspace = path.join(graph.relative, "pnpm-workspace.yaml");
  if (graph.command === "pnpm" && fs.existsSync(path.join(root, workspace))) files.push(workspace);
  if (graph.relative === ".") {
    const patches = path.join(root, "patches");
    if (fs.existsSync(patches)) files.push(...fs.readdirSync(patches).filter(name => name.endsWith(".patch")).map(name => `patches/${name}`));
  }
  return sha256(JSON.stringify([1, process.platform, process.arch, process.versions.node.split(".")[0],
    ...files.sort().map(file => [file, sha256(fs.readFileSync(path.join(root, file)))])]));
}

function missingDependencies(root, graph) {
  return graph.packages.flatMap(relative => {
    const directory = path.join(root, relative), manifest = readJson(path.join(directory, "package.json"));
    return Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).filter(name => {
      try { return !fs.statSync(path.join(directory, "node_modules", name, "package.json")).isFile(); }
      catch { return true; } // Includes dangling pnpm links after an interrupted install.
    });
  });
}

function installationLock(graph) {
  return sha256(fs.readFileSync(path.join(graph.directory, "node_modules", graph.installedLock)));
}

function ready(root, graph) {
  try {
    const stamp = readJson(path.join(graph.directory, "node_modules", STAMP));
    return stamp.inputs === fingerprint(root, graph) && stamp.installedLock === installationLock(graph) && missingDependencies(root, graph).length === 0;
  } catch { return false; }
}

/** A stamp belongs to the actual node_modules on this machine, never to synced
 * .context state. Setup and Run share a process lock and recheck after waiting;
 * a failed/cancelled install cannot certify a partially written dependency tree. */
export async function ensureDevelopmentDependencies(root, { force = false, signal, progress = message => console.error(`[zeros-dev] ${message}`) } = {}) {
  signal?.throwIfAborted();
  const graphs = dependencyGraphs(root);
  if (!force && graphs.every(graph => ready(root, graph))) return;
  const owner = sha256(fs.realpathSync(root)).slice(0, 24);
  const directory = privateDirectory(privateDirectory(developmentHome(), "dependencies"), owner);
  let waiting = false;
  const release = await pollProvider("Dev dependency preparation", () => {
    try { return acquireWorkspaceLock({ directory, state: { owner } }, "mutation.lock"); }
    catch (error) {
      if (error?.code !== "DEV_LOCAL_BUSY") throw error;
      if (!waiting) { progress("Waiting for this checkout's dependency installation to finish"); waiting = true; }
      return false;
    }
  }, { signal, timeout: 15 * 60_000, interval: 250 });
  try {
    for (const graph of graphs) {
      signal?.throwIfAborted();
      if (!force && ready(root, graph)) continue;
      const inputs = fingerprint(root, graph), stamp = path.join(graph.directory, "node_modules", STAMP);
      fs.rmSync(stamp, { force: true });
      progress(`Installing ${graph.label} dependencies from its lockfile`);
      // CI prevents pnpm from prompting when repairing node_modules in a
      // noninteractive Run. Provider credentials never reach install scripts.
      await run(graph.command, graph.args, { cwd: root, env: { ...systemEnvironment(), CI: "true" }, signal,
        inherit: true, timeout: 10 * 60_000, label: `${graph.label} dependency installation` });
      signal?.throwIfAborted();
      if (fingerprint(root, graph) !== inputs) throw new Error("Dependency inputs changed during installation; run again to prepare the current checkout");
      if (missingDependencies(root, graph).length) throw new Error(`${graph.label} dependencies are still incomplete; rerun Setup before launching Dev`);
      writePrivateJson(stamp, { inputs, installedLock: installationLock(graph) });
    }
  } finally { release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Dependency installation interrupted; Run will retry it"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, cancel);
  try {
    if (process.argv.slice(2).some(arg => arg !== "--install")) throw new Error("Use dependencies.mjs [--install]");
    await ensureDevelopmentDependencies(path.resolve(import.meta.dirname, "../.."), { force: process.argv.includes("--install"), signal: controller.signal });
  } catch (error) { console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Dependency preparation failed"}`); process.exitCode = 1; }
  finally { for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, cancel); }
}
