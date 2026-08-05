#!/usr/bin/env node
// ──────────────────────────────────────────────────────────
// Release smoke test — boot the PACKAGED engine and assert it ANSWERS.
// ──────────────────────────────────────────────────────────
//
// WHY THIS EXISTS: the engine ships as a Bun single-file executable
// (`bun build --compile`, see build-sidecar.mjs). CI built that binary but
// never RAN it — preflight only does a cross-compile LINK check on ubuntu (the
// arm64 binary can't execute on Linux). So three releases (0.0.1–0.0.3) shipped
// with an engine that crash-looped on startup: @parcel/watcher's native
// `watcher.node` addon cannot load from inside a `bun --compile` binary, the
// engine exited before binding, and the app sat forever on "did not bind".
//
// This gate closes that hole: it spawns the real binary exactly as
// apps/desktop/electron/sidecar.ts does (`serve --port <free> --root <tmp>`) and FAILS if it
// doesn't sustain external exact-identity /health responses or complete a
// create → archive → restore round trip — catching native-module crashes,
// event-loop deadlocks, and bridge/lifecycle failures before they ship.
//
// Runs on macOS (where the native arm64 binary can execute):
//   - preflight.yml `source-sync` job (pull-request hard gate).
//   - release.yml `build` job, right after `pnpm build:sidecar` (hard gate).
//   - scheduled.yml `electron-pack` job (weekly early-warning).
//
// Usage:
//   pnpm smoke:engine        # boots the built binary; builds it first if missing
//   node scripts/smoke-engine.mjs
// ──────────────────────────────────────────────────────────

import { execSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

// Match build-sidecar.mjs's arch → host-triple mapping so we boot the same file
// it wrote. (apps/desktop/electron/sidecar.ts resolves the runtime binary the same way.)
const TRIPLE = { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" }[
  process.arch
];
if (process.platform !== "darwin" || !TRIPLE) {
  // The binary is a native macOS executable; it can only be RUN on macOS. On any
  // other host (e.g. preflight's ubuntu link check) skip rather than fail.
  console.log(
    `[smoke-engine] skipped — engine binary only runs on macOS (got ${process.platform}/${process.arch}).`,
  );
  process.exit(0);
}

const binary = resolve(repoRoot, "binaries", `zeros-engine-${TRIPLE}`);
const BIND_TIMEOUT_MS = 60_000; // generous for a cold CI runner; local boot ~35ms
const HEALTH_GRACE_AFTER_READY_MS = 5_000;
const PROBE_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg, output) {
  console.error(`\n[smoke-engine] ❌ ${msg}`);
  if (output !== undefined) {
    console.error("──────── engine output ────────");
    console.error(output.trim() || "(no output captured)");
    console.error("───────────────────────────────");
  }
  process.exit(1);
}

// Build on demand so `pnpm smoke:engine` works standalone. In CI the build job
// already produced the binary, so this is a no-op.
if (!existsSync(binary)) {
  console.log("[smoke-engine] binary missing — building (pnpm build:sidecar)…");
  execSync("node scripts/build-sidecar.mjs", {
    cwd: repoRoot,
    stdio: "inherit",
  });
}
if (!existsSync(binary))
  fail(`engine binary still missing after build: ${binary}`);

// Let the OS hand us a free port, then pass it to the engine via --port.
function getFreePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.once("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

// Prove an INDEPENDENT process can drive the packaged sidecar's application
// event loop, not merely complete a TCP handshake against its listen backlog.
// beta.84 passed the old connect-only check while every HTTP/WS request hung:
// its early same-process probe passed, then native FSEvents initialization
// deadlocked the Bun-compiled event loop later in startup.
function probeHealth(port) {
  return new Promise((res) => {
    let settled = false;
    const done = (instance) => {
      if (settled) return;
      settled = true;
      res(instance);
    };
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/health",
        method: "GET",
        timeout: 1_000,
        headers: { Host: `127.0.0.1:${port}` },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          if (body.length < 8192) body += chunk;
        });
        response.once("end", () => {
          if (response.statusCode !== 200) return done(null);
          try {
            const parsed = JSON.parse(body);
            done(
              parsed?.status === "ok" &&
                typeof parsed?.instance === "string" &&
                parsed.instance.length > 0
                ? parsed.instance
                : null,
            );
          } catch {
            done(null);
          }
        });
        response.once("error", () => done(null));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      done(null);
    });
    req.once("error", () => done(null));
    req.end();
  });
}

/** Exercise the exact bridge operations whose UI surfaces all fail together
 * when the packaged engine's event loop is wedged. The repository, DB, visible
 * worktree root, and token are all throwaway values inside the smoke sandbox. */
async function smokeWorkspaceLifecycle({ port, token, root }) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`,
  );
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolveReady, rejectReady) => {
    readyResolve = resolveReady;
    readyReject = rejectReady;
  });

  const failPending = (reason) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };
  const send = (fields) => {
    const id = randomUUID();
    ws.send(
      JSON.stringify({
        ...fields,
        id,
        timestamp: Date.now(),
      }),
    );
    return id;
  };

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === "ENGINE_READY") {
      send({
        type: "CONNECTED",
        source: "client",
        capabilities: [],
        protocolVersion: 3,
      });
      readyResolve();
      return;
    }
    if (msg.type !== "WORKSPACE_RESPONSE" && msg.type !== "WORKSPACE_ERROR") {
      return;
    }
    const entry = pending.get(String(msg.requestId));
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(String(msg.requestId));
    if (msg.type === "WORKSPACE_ERROR") {
      entry.reject(
        new Error(
          `${String(msg.code)}: ${String(msg.message ?? "workspace error")}`,
        ),
      );
    } else {
      entry.resolve(msg.result);
    }
  });
  ws.once("error", (error) => {
    const reason = error instanceof Error ? error.message : String(error);
    readyReject(new Error(reason));
    failPending(reason);
  });
  ws.once("close", (code, reason) => {
    const message = `bridge closed ${code} ${reason.toString()}`;
    readyReject(new Error(message));
    failPending(message);
  });

  const readyTimer = setTimeout(
    () => readyReject(new Error("bridge handshake timed out (10s)")),
    10_000,
  );
  await ready.finally(() => clearTimeout(readyTimer));

  const request = (op, params = {}) =>
    new Promise((resolveRequest, rejectRequest) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`${op} timed out (60s)`));
      }, 60_000);
      pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timer,
      });
      ws.send(
        JSON.stringify({
          type: "WORKSPACE_REQUEST",
          source: "client",
          op,
          params,
          id,
          timestamp: Date.now(),
        }),
      );
    });

  try {
    const created = await request("workspace.create", {
      repoRoot: root,
      repoSlug: "packaged-smoke",
      baseBranch: "main",
      prompt: "packaged lifecycle smoke",
    });
    if (
      !created ||
      typeof created.workspaceId !== "string" ||
      typeof created.path !== "string" ||
      !existsSync(created.path)
    ) {
      throw new Error("workspace.create did not publish a usable checkout");
    }

    await request("workspace.archive", {
      workspaceId: created.workspaceId,
      stashUncommitted: false,
    });
    if (existsSync(created.path)) {
      throw new Error("workspace.archive left its checkout on disk");
    }

    const restored = await request("workspace.restore", {
      workspaceId: created.workspaceId,
    });
    if (
      !restored ||
      typeof restored.path !== "string" ||
      !existsSync(restored.path)
    ) {
      throw new Error("workspace.restore did not recreate a usable checkout");
    }
  } finally {
    ws.close();
  }
}

const port = await getFreePort();
const sandbox = mkdtempSync(join(tmpdir(), "zeros-engine-smoke-"));
const root = join(sandbox, "repo");
const dataDir = join(sandbox, "data");
const workspacesDir = join(sandbox, "workspaces");
const localToken = randomBytes(32).toString("hex");
mkdirSync(root, { recursive: true });
// Mirror a real workspace. This is a release gate for workspace lifecycle, so
// inability to construct the Git fixture is itself a hard failure.
try {
  execSync("git init -q -b main", { cwd: root });
  execSync(
    "git -c user.email=smoke@zeros -c user.name=smoke commit -q --allow-empty -m init",
    { cwd: root },
  );
} catch (error) {
  rmSync(sandbox, { recursive: true, force: true });
  console.error(
    `[smoke-engine] ❌ could not initialize lifecycle fixture: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exit(1);
}

console.log(`[smoke-engine] booting ${binary}`);
console.log(`[smoke-engine]   serve --port ${port} --root ${root}`);

let output = "";
let exited = null;
const child = spawn(
  binary,
  [
    "serve",
    "--port",
    String(port),
    "--port-start",
    String(port),
    "--port-span",
    "1",
    "--root",
    root,
  ],
  {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      ZEROS_DEV: "0",
      ZEROS_RUNTIME_MODE: "packaged",
      ZEROS_DATA_DIR: dataDir,
      ZEROS_WORKSPACES_DIR: workspacesDir,
      ZEROS_USER_SETTINGS_DIR: join(sandbox, "settings"),
      ZEROS_LOCAL_WS_TOKEN: localToken,
      ZEROS_REQUIRE_ACCOUNT: "0",
    },
  },
);
child.stdout.on("data", (b) => (output += b.toString()));
child.stderr.on("data", (b) => (output += b.toString()));
child.on("exit", (code, signal) => (exited = { code, signal }));

function cleanup() {
  try {
    if (exited === null) child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
// Don't leave an orphan engine if the runner cancels the job.
process.once("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.once("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

// Surface the historical failure mode (and any boot crash) with a precise message.
function crashMarker() {
  if (/watcher\.node|Cannot require module/i.test(output))
    return "engine crashed loading a native module (watcher.node / 'Cannot require module') — a native addon that can't be loaded from inside the `bun --compile` binary. Move it to a pure-JS equivalent (see apps/desktop/src/engine/git/detach.ts → chokidar).";
  if (/unhandledRejection|uncaughtException/i.test(output))
    return "engine threw during startup (unhandledRejection / uncaughtException).";
  return null;
}

const readyRe = new RegExp(`Engine ready on port ${port}`);
const deadline = Date.now() + BIND_TIMEOUT_MS;
let readyAt = null;
let healthy = false;
let healthyInstance = null;
let consecutiveHealthy = 0;
while (Date.now() < deadline) {
  if (exited !== null) {
    const why = crashMarker();
    cleanup();
    fail(
      `engine exited before binding (code=${exited.code} signal=${exited.signal}).${why ? " " + why : ""}`,
      output,
    );
  }
  const why = crashMarker();
  if (why) {
    cleanup();
    fail(why, output);
  }
  if (readyAt === null && readyRe.test(output)) readyAt = Date.now();
  const observedInstance = await probeHealth(port);
  if (readyAt !== null) {
    if (
      observedInstance &&
      (healthyInstance === null || observedInstance === healthyInstance)
    ) {
      healthyInstance = observedInstance;
      consecutiveHealthy += 1;
    } else {
      healthyInstance = observedInstance;
      consecutiveHealthy = observedInstance ? 1 : 0;
    }
    if (consecutiveHealthy >= 3) {
      healthy = true;
      break;
    }
  }
  if (readyAt !== null && Date.now() - readyAt >= HEALTH_GRACE_AFTER_READY_MS) {
    cleanup();
    fail(
      `engine logged ready but did not sustain external /health within ` +
        `${HEALTH_GRACE_AFTER_READY_MS / 1000}s`,
      output,
    );
  }
  await sleep(PROBE_INTERVAL_MS);
}

if (!healthy) {
  cleanup();
  fail(
    `engine did not answer 127.0.0.1:${port}/health within ${BIND_TIMEOUT_MS / 1000}s`,
    output,
  );
}

try {
  await smokeWorkspaceLifecycle({ port, token: localToken, root });
} catch (error) {
  cleanup();
  fail(
    `packaged workspace create/archive/restore failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    output,
  );
}
if ((await probeHealth(port)) !== healthyInstance) {
  cleanup();
  fail(
    "engine stopped answering /health after workspace lifecycle smoke",
    output,
  );
}

console.log(
  `[smoke-engine] ✅ packaged engine sustained /health + create/archive/restore on 127.0.0.1:${port}`,
);
cleanup();
process.exit(0);
