#!/usr/bin/env node
// Account-free native development. This launcher never imports the hosted
// lifecycle or an auth profile. Main supplies the mode to preload and engine.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { portFree } from "./dev-ports.mjs";

const require = createRequire(import.meta.url);
const bundle = require("./dev-electron-bundle.cjs");
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
      /^(?:ZEROS_|AUTH_|AUTH0_|WORKOS_|CLOUD_|CONTROL_PLANE_|DAYTONA_|RAILWAY_|PLANETSCALE_|CLOUDFLARE_|CF_|R2_)/.test(
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

export async function pickLocalPorts(slug, attempt = 0) {
  const hash = createHash("sha256")
    .update(`${slug}:${attempt}`)
    .digest()
    .readUInt32BE(0);
  let vitePort;
  for (let i = 0; i < VITE_SLOTS; i++) {
    const port = VITE_BASE + ((hash + i) % VITE_SLOTS);
    if (await portFree(port)) {
      vitePort = port;
      break;
    }
  }
  let engineBase;
  for (let i = 0; i < ENGINE_SLOTS; i++) {
    const base = ENGINE_BASE + ((hash + i) % ENGINE_SLOTS) * STRIDE;
    let free = true;
    for (let offset = 0; offset < STRIDE; offset++) {
      if (!(await portFree(base + offset))) {
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
  { cwd, env, signal, output, killGraceMs = 20_000 },
) {
  if (signal?.aborted) return Promise.resolve({ code: 0, cancelled: true });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let collision = false,
      recent = "",
      timer;
    const stop = () => {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        /* already stopped */
      }
      timer ??= setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* already stopped */
        }
      }, killGraceMs);
    };
    const abort = () => stop();
    signal?.addEventListener("abort", abort, { once: true });
    for (const [stream, target] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        if (output) output(chunk.toString());
        else target.write(chunk);
        recent = (recent + chunk.toString()).slice(-4096);
        if (
          !collision &&
          /EADDRINUSE|Port [0-9]+ is already in use/.test(recent)
        ) {
          collision = true;
          stop();
        }
      });
    }
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      resolve({
        code: signal?.aborted ? 0 : collision ? 98 : (code ?? 1),
        cancelled: signal?.aborted ?? false,
      });
    });
    if (signal?.aborted) stop();
  });
}

function launcherLock(root, slug) {
  // A second launch of the same checkout must not rebuild its running app.
  // Different checkouts never contend, even when they share branch names.
  const directory = path.join(root, ".context", "zeros-local");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "launcher.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, slug }));
      fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        throw new Error(
          "Zeros Local launcher lock is incomplete; stop Local before removing .context/zeros-local/launcher.lock.",
        );
      }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
        throw new Error("Invalid Zeros Local launcher lock.");
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        if (error.code === "ESRCH") {
          fs.unlinkSync(file);
          continue;
        }
        throw error;
      }
      throw new Error(
        "Zeros Local is already running for this checkout. Stop it before restarting.",
      );
    }
  }
  throw new Error("Zeros Local launcher lock changed; retry.");
}

const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;

export async function runLocalDevelopment({
  root = process.cwd(),
  platform = process.platform,
  environment = process.env,
  signal,
  run = runOwnedProcess,
  prepareBundle = bundle.prepareLocalInstanceBundle,
} = {}) {
  if (platform !== "darwin")
    throw new Error(
      "Zeros Local requires macOS. Run pnpm electron:local in this checkout on the Mac.",
    );
  const identity = checkoutIdentity(root);
  const unlock = launcherLock(root, identity.slug);
  try {
    let ports = await pickLocalPorts(identity.slug);
    let env = localEnvironment({ identity, ...ports, environment });
    // Exactly the existing real local build (ABI, ZSR, engine, main), with the
    // Local environment present BEFORE build-time defines are baked.
    const prepared = await run("pnpm", ["electron:dev:prep"], {
      cwd: root,
      env,
      signal,
    });
    if (prepared.cancelled || signal?.aborted || prepared.code !== 0)
      return prepared.code;
    const result = prepareBundle(identity);
    const binary = typeof result === "string" ? result : result?.binPath;
    if (!binary)
      throw new Error(
        "Could not prepare the isolated Zeros Local Electron bundle. Check the root pnpm install.",
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal?.aborted) return 0;
      if (attempt) ports = await pickLocalPorts(identity.slug, attempt);
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
          "--kill-timeout",
          "20000",
          "-n",
          "vite,engine,main,app",
          "-c",
          "cyan,yellow,magenta,green",
          "pnpm dev",
          "tsup --watch",
          "tsup --config apps/desktop/electron/tsup.config.ts --watch",
          app,
        ],
        { cwd: root, env, signal },
      );
      if (stack.cancelled || stack.code !== 98) return stack.code;
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

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => controller.abort());
  try {
    process.exitCode = await runLocalDevelopment({ signal: controller.signal });
  } catch (error) {
    console.error(`[electron:local] ${error.message}`);
    process.exitCode = 1;
  }
}
