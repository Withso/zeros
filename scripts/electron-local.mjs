#!/usr/bin/env node
// Account-free native development. This launcher never imports the hosted
// lifecycle or an auth profile. Main supplies the mode to preload and engine.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { portFree } from "./dev-ports.mjs";
import { groupAlive, signalGroup } from "./electron-local-process-group.mjs";

const require = createRequire(import.meta.url);
const bundle = require("./dev-electron-bundle.cjs");
const watchdogPath = fileURLToPath(
  new URL("./electron-local-watchdog.mjs", import.meta.url),
);
const ENGINE_BASE = 31000,
  ENGINE_SLOTS = 512,
  STRIDE = 10;
const VITE_BASE = 6200,
  VITE_SLOTS = 1024;

export function checkoutIdentity(root) {
  // A synced checkout has a .git directory, just like the primary clone.
  // Canonical checkout path handles both it and linked worktrees, and survives
  // branch switches/restarts. No shared .context UUID can be copied to siblings.
  const canonical = fs.realpathSync(root);
  const slug = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
  const label =
    path
      .basename(canonical)
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .slice(0, 32) || "checkout";
  return { slug, name: `Zeros Local ${label} ${slug.slice(0, 6)}` };
}

export function localEnvironment({
  identity,
  vitePort,
  engineBase,
  environment = process.env,
}) {
  const env = { ...environment };
  // Do not inherit another app's identity, hosted credentials, public auth
  // selector, cloud deployment inputs or build-time capability. Provider CLI
  // credentials/HOME remain ordinary provider credentials, separate from Zeros.
  for (const key of Object.keys(env)) {
    if (
      /^(?:ZEROS_|AUTH_|AUTH0_|WORKOS_|CLOUD_|CONTROL_PLANE_|RAILWAY_|PLANETSCALE_|CLOUDFLARE_|CF_|R2_)/.test(
        key,
      )
    )
      delete env[key];
    if (key.startsWith("VITE_")) env[key] = "";
  }
  // Empty values take precedence over .env files loaded by Vite. These are
  // defense in depth; renderer/native service gates use main's mode instead.
  for (const key of [
    "VITE_CONTROL_PLANE_URL",
    "VITE_APP_BASE_URL",
    "VITE_POSTHOG_KEY_DEV",
    "VITE_POSTHOG_KEY_PROD",
    "VITE_POSTHOG_HOST",
  ])
    env[key] = "";
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  Object.assign(env, {
    ZEROS_DEV: "1",
    ZEROS_CHANNEL: "dev",
    VITE_ZEROS_CHANNEL: "dev",
    ZEROS_LOCAL_DEVELOPMENT: "1",
    ZEROS_ISOLATE: "1",
    ZEROS_INSTANCE: identity.slug,
    ZEROS_INSTANCE_NAME: identity.name,
    ZEROS_DEV_NODE_EXECUTABLE: process.execPath,
    ZEROS_CLOUD_WORKSPACES_ENABLED: "false",
    ZEROS_VITE_PORT: String(vitePort),
    ZEROS_ENGINE_BASE_PORT: String(engineBase),
    ELECTRON_RENDERER_URL: `http://localhost:${vitePort}`,
  });
  for (const key of [
    "ZEROS_NO_ENGINE_HMR",
    "ZEROS_NO_MAIN_HMR",
    "ZEROS_DEVTOOLS",
  ]) {
    if (environment[key] !== undefined) env[key] = environment[key];
  }
  return env;
}

export async function pickLocalPorts(
  slug,
  attempt = 0,
  { portFree: probe = portFree, excluded = new Set() } = {},
) {
  const hash = createHash("sha256")
    .update(`${slug}:${attempt}`)
    .digest()
    .readUInt32BE(0);
  let vitePort;
  for (let i = 0; i < VITE_SLOTS; i++) {
    const port = VITE_BASE + ((hash + i) % VITE_SLOTS);
    if (!excluded.has(port) && (await probe(port))) {
      vitePort = port;
      break;
    }
  }
  let engineBase;
  for (let i = 0; i < ENGINE_SLOTS; i++) {
    const base = ENGINE_BASE + ((hash + i) % ENGINE_SLOTS) * STRIDE;
    let free = true;
    for (let offset = 0; offset < STRIDE; offset++) {
      if (excluded.has(base + offset) || !(await probe(base + offset))) {
        free = false;
        break;
      }
    }
    if (free) {
      engineBase = base;
      break;
    }
  }
  if (vitePort === undefined || engineBase === undefined)
    throw new Error(
      "No free Zeros Local port block; stop an unused Local instance and retry.",
    );
  return { vitePort, engineBase };
}

/** One owned group for preparation or the concurrently stack. Signal both the
 * wrapper and its children, then await closure before retrying or releasing the
 * launcher lock. The existing main supervisor/sidecar own engine teardown. */
export function runOwnedProcess(
  command,
  args,
  { cwd, env, signal, output, killGraceMs = 20_000, startup },
) {
  if (signal?.aborted) return Promise.resolve({ code: 0, cancelled: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    const terminated = new Promise((done) => {
      child.once("exit", done);
      child.once("error", done);
    });
    const guardian = child.pid
      ? spawn(
          process.execPath,
          [
            watchdogPath,
            String(process.pid),
            String(child.pid),
            String(killGraceMs),
          ],
          {
            detached: true,
            stdio: "ignore",
            env: {},
          },
        )
      : null;
    const guardianExited = guardian
      ? new Promise((done) => {
          guardian.once("exit", done);
          guardian.once("error", done);
        })
      : Promise.resolve();
    let collision = false,
      recent = "",
      stopping = false,
      failure;
    const startupDeadline = Date.now() + (startup?.timeoutMs ?? 120_000);
    let viteReady = false,
      engineReady = false,
      startupArmed = Boolean(startup);
    const stop = async (error) => {
      failure ??= error;
      if (stopping) return;
      stopping = true;
      signalGroup(child.pid, "SIGTERM");
      const deadline = Date.now() + killGraceMs;
      while (groupAlive(child.pid) && Date.now() < deadline) await delay(25);
      if (groupAlive(child.pid)) signalGroup(child.pid, "SIGKILL");
      while (groupAlive(child.pid)) await delay(25);
      await terminated;
      guardian?.kill("SIGTERM");
      await guardianExited;
      signal?.removeEventListener("abort", abort);
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (failure) reject(failure);
      else
        resolve({
          code: signal?.aborted ? 0 : collision ? 98 : (child.exitCode ?? 1),
          cancelled: signal?.aborted ?? false,
        });
    };
    const abort = () => {
      void stop();
    };
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        try {
          if (output) output(chunk.toString());
          else target.write(chunk);
        } catch (error) {
          void stop(error);
        }
        recent = (recent + chunk.toString())
          .replace(/\x1b\[[0-9;]*m/g, "")
          .slice(-4096);
        if (!startupArmed) return;
        viteReady ||= /\[vite\]\s+VITE v[^\n]*\bready in\b/.test(recent);
        const readyPort = recent.match(
          /\[Zeros\] engine ready and externally verified on port (\d+)/,
        )?.[1];
        engineReady ||=
          readyPort !== undefined &&
          Number(readyPort) >= startup.engineBase &&
          Number(readyPort) < startup.engineBase + 8;
        if ((viteReady && engineReady) || Date.now() >= startupDeadline) {
          startupArmed = false;
          return;
        }
        const viteFailure = new RegExp(
          `\\[vite\\]\\s+(?:Error: )?Port ${startup.vitePort} is already in use\\b`,
        );
        const engineFailure = recent.match(
          /\[engine\]\s+Failed to start engine:\s*Error: listen EADDRINUSE: address already in use 127\.0\.0\.1:(\d+)\b/,
        );
        if (
          !collision &&
          (viteFailure.test(recent) ||
            (engineFailure &&
              Number(engineFailure[1]) >= startup.engineBase &&
              Number(engineFailure[1]) < startup.engineBase + 8))
        ) {
          collision = true;
          void stop();
        }
      });
      stream.on("error", (error) => {
        void stop(error);
      });
    }
    child.once("error", (error) => {
      void stop(error);
    });
    guardian?.once("error", (error) => {
      void stop(error);
    });
    child.once("exit", () => {
      void stop();
    });
    if (signal?.aborted) abort();
  });
}

const activeLockTokens = new Set();

function launcherLock(root, slug) {
  // A second launch of the same checkout must not rebuild its running app.
  // Different checkouts never contend, even when they share branch names.
  const directory = path.join(root, ".context", "zeros-local");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "launcher.lock");
  const token = randomUUID();
  const record = JSON.stringify({ pid: process.pid, slug, token });
  const read = () => {
    let raw;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    try {
      return { raw, owner: JSON.parse(raw) };
    } catch {
      throw new Error(
        "Zeros Local launcher lock is incomplete; stop Local before removing .context/zeros-local/launcher.lock.",
      );
    }
  };
  acquire: for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = path.join(directory, `launcher-${token}.tmp`);
    try {
      fs.writeFileSync(temporary, record, { flag: "wx", mode: 0o600 });
      try {
        // Publish complete private JSON without overwriting another owner.
        fs.linkSync(temporary, file);
        activeLockTokens.add(token);
        return () => {
          try {
            if (read()?.owner.token === token) fs.unlinkSync(file);
          } finally {
            activeLockTokens.delete(token);
          }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    const snapshot = read();
    if (!snapshot) continue;
    const { owner } = snapshot;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
      throw new Error("Invalid Zeros Local launcher lock.");
    let live = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") live = false;
      else throw error;
    }
    if (
      live &&
      !(owner.pid === process.pid && activeLockTokens.has(owner.token))
    ) {
      // A recycled PID (including after reboot) is not a launcher owner.
      try {
        const command = execFileSync(
          "ps",
          ["-o", "command=", "-p", String(owner.pid)],
          { encoding: "utf8", timeout: 2000 },
        );
        live = command.includes("electron-local.mjs");
      } catch {
        // The PID can disappear between kill(0) and this read-only probe.
        live = false;
      }
    }
    if (live)
      throw new Error(
        "Zeros Local is already running for this checkout. Stop it before restarting.",
      );
    const generation = createHash("sha256").update(snapshot.raw).digest("hex");
    const recovery = path.join(directory, `recovery-${generation}.lock`);
    let fd;
    for (let fenceAttempt = 0; fenceAttempt < 3; fenceAttempt++) {
      try {
        fd = fs.openSync(recovery, "wx", 0o600);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          const abandoned = fs.statSync(recovery);
          if (Date.now() - abandoned.mtimeMs <= 30_000) break;
          if (read()?.raw !== snapshot.raw) continue acquire;
          const current = fs.statSync(recovery);
          if (
            current.ino === abandoned.ino &&
            current.mtimeMs === abandoned.mtimeMs
          )
            fs.unlinkSync(recovery);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    if (fd === undefined) {
      throw new Error(
        "Zeros Local lock recovery is already in progress; retry after it completes.",
      );
    }
    try {
      // Retire only the stale generation inspected before taking the fence.
      if (read()?.raw === snapshot.raw) fs.unlinkSync(file);
    } finally {
      const held = fs.fstatSync(fd);
      fs.closeSync(fd);
      try {
        if (fs.statSync(recovery).ino === held.ino) fs.unlinkSync(recovery);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  throw new Error("Zeros Local launcher lock changed; retry.");
}

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

function assertCheckoutAvailable(root, listProcesses) {
  const scripts = new Set(
    [path.resolve(root), fs.realpathSync(root)].map((checkout) =>
      path.join(checkout, "scripts", "dev-instance.mjs"),
    ),
  );
  const processes = listProcesses();
  for (const script of scripts) {
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|[\\s"'])${escaped}(?:$|[\\s"'])`, "m").test(processes))
      throw new Error(
        "Zeros Dev is running from this checkout. Local and Dev share build outputs; stop Dev or use a separate checkout before launching Zeros Local.",
      );
  }
}

export async function runLocalDevelopment({
  root = process.cwd(),
  platform = process.platform,
  environment = process.env,
  signal,
  run = runOwnedProcess,
  prepareBundle = bundle.prepareLocalInstanceBundle,
  portProber = portFree,
  listProcesses = () =>
    execFileSync("ps", ["-axww", "-o", "pid=,command="], {
      encoding: "utf8",
      timeout: 2000,
    }),
} = {}) {
  if (platform !== "darwin")
    throw new Error(
      "Zeros Local requires macOS. Run pnpm electron:local in this checkout on the Mac.",
    );
  assertCheckoutAvailable(root, listProcesses);
  const identity = checkoutIdentity(root);
  const unlock = launcherLock(root, identity.slug);
  try {
    const excluded = new Set();
    let ports = await pickLocalPorts(identity.slug, 0, {
      portFree: portProber,
      excluded,
    });
    let env = localEnvironment({ identity, ...ports, environment });
    // Exactly the existing real local build (ABI, search assets, engine, main), with the
    // Local environment present BEFORE build-time defines are baked.
    const prepared = await run("pnpm", ["electron:dev:prep"], {
      cwd: root,
      env,
      signal,
    });
    if (prepared.cancelled || signal?.aborted || prepared.code !== 0)
      return prepared.code;
    const result = prepareBundle({
      ...identity,
      paths: bundle.localInstanceBundlePaths(identity),
    });
    const binary = typeof result === "string" ? result : result?.binPath;
    if (!binary)
      throw new Error(
        "Could not prepare the isolated Zeros Local Electron bundle. Check the root pnpm install.",
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) return 0;
      if (attempt)
        ports = await pickLocalPorts(identity.slug, attempt, {
          portFree: portProber,
          excluded,
        });
      env = localEnvironment({ identity, ...ports, environment });
      const launch =
        env.ZEROS_NO_MAIN_HMR === "1"
          ? `${quote(binary)} .`
          : `${quote(process.execPath)} scripts/dev-main-supervisor.mjs ${quote(binary)}`;
      const app = `wait-on -t 120000 -d 750 http://localhost:${ports.vitePort} dist-electron/main.cjs dist-electron/preload.cjs dist-engine/cli.js && ${launch}`;
      console.log(
        `[electron:local] ${identity.name} · vite=${ports.vitePort} · engine=${ports.engineBase}-${ports.engineBase + 9} · account/cloud services off`,
      );
      const stack = await run(
        "pnpm",
        [
          "exec",
          "concurrently",
          "-k",
          "--success",
          "first",
          "--kill-timeout",
          "20000",
          "-n",
          "vite,engine,main,app,watchdog",
          "-c",
          "cyan,yellow,magenta,green,gray",
          "pnpm dev",
          "tsup --watch",
          "tsup --config apps/desktop/electron/tsup.config.ts --watch",
          app,
          `${quote(process.execPath)} ${quote(watchdogPath)} ${process.pid}`,
        ],
        { cwd: root, env, signal, startup: ports },
      );
      if (stack.cancelled || stack.code !== 98) return stack.code;
      excluded.add(ports.vitePort);
      for (let offset = 0; offset < STRIDE; offset++)
        excluded.add(ports.engineBase + offset);
      console.warn(`[electron:local] port race; retry ${attempt + 1}/3`);
    }
    console.error(
      "[electron:local] ports collided on three attempts; stop an unused Local instance and retry.",
    );
    return 98;
  } finally {
    unlock();
  }
}

function isMainModule() {
  try {
    return (
      process.argv[1] &&
      fs.realpathSync(process.argv[1]) ===
        fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const controller = new AbortController();
  let failed = false;
  const fatal = () => {
    failed = true;
    controller.abort();
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);
  process.stdout.on("error", fatal);
  process.stderr.on("error", fatal);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"])
    process.on(signal, () => controller.abort());
  try {
    const code = await runLocalDevelopment({ signal: controller.signal });
    process.exitCode = failed ? 1 : code;
  } catch (error) {
    if (!failed) console.error(`[electron:local] ${error.message}`);
    process.exitCode = 1;
  }
}
