#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { ensureWorkspace, acquireWorkspaceLock, systemEnvironment, privateDirectory, writePrivateFile, saveWorkspace } from "./state.mjs";
import { loadProfile, profileIssues, publicDevProfile, desktopEnvironment, backendEnvironment, webEnvironment } from "./profile.mjs";
import { ensureTunnel, configureTunnel, deleteTunnel } from "./cloudflare.mjs";
import { ensureWorkosWebhook, deleteWorkosWebhook } from "./workos.mjs";
import { startPostgres, pickServicePorts, migratePostgres, databaseCommand } from "./postgres.mjs";
import { DevelopmentProcesses, run, waitForHttp, waitForDevSignIn } from "./processes.mjs";
import { ensureDevAuthEnvironment } from "../dev-auth-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const action = process.argv[2] ?? "start";
const watch = !process.argv.includes("--run-only");

async function verifyAlpha(profile) {
  if (profile.workos?.environment !== "alpha") return;
  const auth = await ensureDevAuthEnvironment({ processEnv: {} });
  if (auth.issue || auth.source === "none" || auth.env.AUTH_DESKTOP_CLIENT_ID !== profile.workos.desktopClientId ||
      auth.env.AUTH_ISSUER !== `https://api.workos.com/user_management/${profile.workos.webClientId}`) {
    throw new Error("The explicitly shared Alpha identity no longer matches Alpha's published auth contract; refresh the private profile");
  }
}

async function stop(workspace) {
  const receipt = workspace.state.launcher;
  if (!receipt) return;
  try {
    const response = await fetch(`http://127.0.0.1:${receipt.port}/stop`, { method: "POST", redirect: "error",
      headers: { authorization: `Bearer ${receipt.token}` }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
  } catch { throw new Error("The Dev supervisor is unavailable; existing state was preserved. Inspect pnpm dev:doctor before recovering its processes."); }
  const deadline = Date.now() + 45_000;
  while (fs.existsSync(path.join(workspace.directory, "run.lock"))) {
    if (Date.now() > deadline) throw new Error("Development shutdown has not completed; retry after it drains");
    await delay(250);
  }
}

async function start(workspace, profile) {
  if (workspace.state.status !== "active") throw new Error("This development workspace is archived or awaiting cleanup; finish pnpm dev:archive before restoring it");
  const issues = profileIssues(profile, { cloud: Boolean(profile.cloud) });
  if (issues.length) throw new Error(issues.join("\n"));
  const release = acquireWorkspaceLock(workspace), processes = new DevelopmentProcesses();
  const env = systemEnvironment(), runId = randomUUID(), token = randomUUID();
  let postgres, server;
  const abort = () => processes.controller.abort(new Error("Development shutdown requested"));
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, abort);
  const signal = processes.controller.signal;
  try {
    server = createServer((request, response) => {
      const actual = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
      if (request.method !== "POST" || request.url !== "/stop" || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        response.writeHead(404).end(); return;
      }
      response.writeHead(202).end(); abort();
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    workspace.state.launcher = { port: server.address().port, token, runId, pid: process.pid };
    saveWorkspace(workspace);
    await verifyAlpha(profile); signal.throwIfAborted();
    // No integration secrets enter compilers, dependency installers or Electron.
    for (const file of ["node_modules/.bin/tsup", "apps/control-plane/node_modules/pg", "apps/web/node_modules/wrangler"]) {
      if (!fs.existsSync(path.join(root, file))) throw new Error("Dependencies are missing. Run the repository's Conductor setup script before starting Dev.");
    }
    await run("cloudflared", ["--version"], { env, signal, label: "Cloudflare connector check" });
    const ports = await pickServicePorts();
    console.log("[zeros-dev] Building this checkout's backend and auth web facade");
    await run("pnpm", ["--dir", "apps/control-plane", "build"], { cwd: root, env, signal, timeout: 180_000, label: "Control-plane build" });
    await run("npm", ["--prefix", "apps/web", "run", "build"], { cwd: root, env, signal, timeout: 180_000, label: "Auth web build" });
    console.log("[zeros-dev] Starting isolated PostgreSQL and applying release migrations");
    postgres = await startPostgres(workspace, profile, ports, root); signal.throwIfAborted();
    await migratePostgres(workspace, profile, ports, root); signal.throwIfAborted();
    const tunnel = await ensureTunnel(workspace, profile.cloudflare); signal.throwIfAborted();
    await configureTunnel(workspace, profile.cloudflare, ports); signal.throwIfAborted();
    await ensureWorkosWebhook(workspace, profile); signal.throwIfAborted();
    const apiEnv = { ...env, ...backendEnvironment(workspace, profile, ports, runId) };
    const apiCwd = path.join(root, "apps/control-plane");
    processes.start("Control plane", process.execPath, watch
      ? [path.join(apiCwd, "node_modules/tsx/dist/cli.mjs"), "watch", "--clear-screen=false", "src/index.ts"]
      : [path.join(apiCwd, "dist/index.js")], { cwd: apiCwd, env: apiEnv });
    const healthy = async response => {
      if (!response.ok) return false;
      const health = await response.json();
      return health.development?.owner === workspace.state.owner && health.development?.runId === runId;
    };
    await waitForHttp(`http://127.0.0.1:${ports.api}/healthz`, { signal, accept: healthy });
    // A private working directory prevents Wrangler loading a checkout's
    // .dev.vars or .env and silently mixing its hosted configuration into Dev.
    const webRoot = privateDirectory(workspace.directory, "web");
    const functions = path.join(webRoot, "functions"), sourceFunctions = path.join(root, "apps/web/functions");
    if (fs.existsSync(functions)) {
      if (!fs.lstatSync(functions).isSymbolicLink() || fs.realpathSync(functions) !== fs.realpathSync(sourceFunctions)) throw new Error("Development web source ownership changed");
    } else fs.symlinkSync(sourceFunctions, functions, "dir");
    writePrivateFile(path.join(webRoot, "package.json"), '{"type":"module","private":true}\n');
    writePrivateFile(path.join(webRoot, ".dev.vars"), "");
    processes.start("Auth web facade", process.execPath, [path.join(root, "apps/web/node_modules/wrangler/bin/wrangler.js"),
      "pages", "dev", path.join(root, "apps/web/dist"), "--ip", "127.0.0.1", "--port", String(ports.web),
      "--inspector-port", "0", "--compatibility-date", "2026-07-10", "--kv", "SESSIONS",
      "--persist-to", privateDirectory(webRoot, "state"), "--log-level", "error",
      ...Object.entries(webEnvironment(workspace, profile, ports.api)).flatMap(([key, value]) => ["--binding", `${key}=${value}`]),
    ], { cwd: webRoot, env: { ...env, WRANGLER_SEND_METRICS: "false" } });
    await waitForHttp(`http://127.0.0.1:${ports.web}/`, { signal });
    processes.start("Cloudflare connector", "cloudflared", ["tunnel", "--no-autoupdate", "--metrics", `127.0.0.1:${ports.tunnelMetrics}`,
      "run", "--token-file", tunnel.tokenFile], { cwd: root, env });
    const publicProfile = publicDevProfile(workspace, profile);
    await waitForHttp(`${publicProfile.apiOrigin}/healthz`, { signal, timeout: 120_000, accept: healthy });
    await waitForDevSignIn(publicProfile, { signal, timeout: 120_000 });
    console.log(`[zeros-dev] Ready: ${publicProfile.apiOrigin}`);
    console.log(`[zeros-dev] Identity: ${publicProfile.authEnvironment}; cloud workers: ${profile.cloud ? "enabled" : "not configured"}. Data persists after shutdown.`);
    if (action !== "backend") {
      const desktopEnv = { ...env, ...desktopEnvironment(workspace, profile) };
      await run("pnpm", ["electron:dev:prep"], { cwd: root, env: desktopEnv, signal, inherit: true, timeout: 300_000, label: "Desktop build" });
      processes.start("Zeros Dev", process.execPath, [path.join(root, "scripts/dev-instance.mjs"), watch ? "--watch" : "--run-only"], { cwd: root, env: desktopEnv, stdio: "inherit" });
    }
    if (!signal.aborted) await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true }));
    if (signal.reason?.message !== "Development shutdown requested") throw signal.reason;
  } finally {
    await processes.stop();
    if (postgres) await postgres.stop();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    delete workspace.state.launcher; saveWorkspace(workspace); release();
    for (const sig of ["SIGINT", "SIGTERM"]) process.off(sig, abort);
  }
}

async function main() {
  if (action === "alpha") {
    const auth = await ensureDevAuthEnvironment({ processEnv: {} });
    if (auth.issue || auth.source === "none") throw new Error("A valid Alpha public auth profile is required");
    const env = { ...systemEnvironment(), ...auth.env, ZEROS_DEV: "1", ZEROS_CLOUD_WORKSPACES_ENABLED: "true" };
    await run("pnpm", ["electron:dev:prep"], { cwd: root, env, inherit: true, timeout: 300_000 });
    await run(process.execPath, [path.join(root, "scripts/dev-instance.mjs"), watch ? "--watch" : "--run-only"], { cwd: root, env, inherit: true, timeout: 12 * 3600_000 });
    return;
  }
  if (!["start", "backend", "doctor", "stop", "archive"].includes(action)) throw new Error("Use start, backend, doctor, stop, archive or alpha");
  const workspace = ensureWorkspace({ repositoryRoot: root });
  if (action === "stop") return stop(workspace);
  const profile = loadProfile();
  if (action === "doctor") {
    console.log(JSON.stringify({ owner: workspace.state.owner, status: workspace.state.status,
      tunnelProvisioned: Boolean(workspace.state.tunnel.id), identity: profile.workos?.environment ?? "dev",
      cloudWorkersConfigured: Boolean(profile.cloud), issues: profileIssues(profile, { cloud: true }) }, null, 2));
    return;
  }
  if (action === "archive") {
    await stop(workspace);
    // Re-read after supervisor shutdown so its final receipt cannot be lost.
    const current = ensureWorkspace({ repositoryRoot: root }), release = acquireWorkspaceLock(current);
    let postgres;
    try {
      if (current.state.status === "archived") return;
      current.state.status = "archiving"; saveWorkspace(current);
      const ports = await pickServicePorts(); postgres = await startPostgres(current, profile, ports, root);
      const inventory = await databaseCommand(current, ports, root, "inventory");
      if (inventory.remainingWorkspaces) throw new Error("Owned cloud workspaces remain. Their database and tunnel were preserved; delete them in Zeros Dev before completing archive cleanup.");
      await deleteWorkosWebhook(current, profile); await deleteTunnel(current, profile.cloudflare);
      await postgres.stop(); postgres = undefined;
      for (const name of ["postgres", "desktop", "web", "objects", "backups"]) {
        const directory = path.join(current.directory, name);
        if (fs.existsSync(directory)) {
          if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("Refusing a linked development cleanup target");
          fs.rmSync(directory, { recursive: true });
        }
      }
      current.state.status = "archived"; saveWorkspace(current);
      console.log("[zeros-dev] Development data, owned webhook, DNS and tunnel removed; receipt retained.");
    } finally { if (postgres) await postgres.stop(); release(); }
    return;
  }
  await start(workspace, profile);
}

main().catch(error => {
  if (error?.message === "Development shutdown requested") return;
  console.error(`[zeros-dev] ${error instanceof Error ? error.message : "Development operation failed"}`);
  process.exitCode = 1;
});
