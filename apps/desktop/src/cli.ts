// ──────────────────────────────────────────────────────────
// Zeros CLI
// ──────────────────────────────────────────────────────────
//
// Usage:
//   npx Zeros serve           — Start the engine
//   npx Zeros serve --port N  — Custom port (channel default otherwise)
//   npx Zeros serve --root .  — Custom project root
//   npx Zeros status          — Check engine health
//   npx Zeros --help          — Show usage
//
// ──────────────────────────────────────────────────────────

import * as path from "node:path";
import { findProjectRoot } from "./engine/framework-detector";
import { engineBasePort, ENGINE_PORT_SPAN } from "./engine/runtime";

// ── Serve command ─────────────────────────────────────────

async function runServe(
  cwd: string,
  port: number,
  portStart: number,
  portSpan: number,
  rootOverride?: string,
) {
  const root = rootOverride ? path.resolve(rootOverride) : findProjectRoot(cwd);

  // Safety net: a missing CLI binary, a stray MCP transport reuse, or
  // any other corner case that bubbles past the per-request try/catch
  // used to take the entire engine process down. The dev-script
  // watchdog respawned it 3s later but every in-flight prompt was lost
  // and the UI sat on "Loading…" forever. Log and keep going.
  process.on("uncaughtException", (err) => {
    console.error(
      "[Zeros] uncaughtException:",
      err instanceof Error ? err.stack : err,
    );
  });
  process.on("unhandledRejection", (err) => {
    console.error(
      "[Zeros] unhandledRejection:",
      err instanceof Error ? err.stack : err,
    );
  });

  console.log("");
  console.log("  \x1b[36mZeros\x1b[0m  Starting engine...");
  console.log("");

  // Dynamic import to avoid loading heavy deps for other commands
  const { ZerosEngine } = await import("./engine/zeros-engine");
  const engine = new ZerosEngine({ root, port, portStart, portSpan });

  const shutdown = async () => {
    console.log("\n[Zeros] Shutting down...");
    // Bound the dispose. engine.stop() disposes the chat adapters, and one of
    // them (the Codex app-server) does a JSON-RPC `dispose` round-trip + child
    // kill that can wedge. An unbounded await here is exactly why the engine
    // sometimes "ignored SIGTERM" for the full 5 s the parent waits before
    // SIGKILL (apps/desktop/electron/sidecar.ts killCurrentChild). Race a 3 s cap so we
    // always exit promptly — a clean dispose finishes in ~1-2 s and wins the
    // race; a wedged one is abandoned (the process is dying anyway, and the
    // parent's SIGKILL ceiling still backstops a fully-blocked event loop).
    await Promise.race([
      engine.stop().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 3000)),
    ]);
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);

  try {
    await engine.start();
    console.log("");
    console.log("  \x1b[2mPress Ctrl+C to stop.\x1b[0m");
    console.log("");
    startMemoryLogger();
  } catch (err) {
    console.error("\n  \x1b[31mFailed to start engine:\x1b[0m", err);
    process.exit(1);
  }
}

/** Log engine RSS + V8 heap every 10 min. The numbers are the engine
 *  process only — sibling Electron / renderer / vite processes are
 *  invisible from here. For a memory investigation, timestamps in engine.log
 *  show whether growth happened here or
 *  elsewhere. Costs ~one console.log per 10 minutes. */
function startMemoryLogger() {
  const fmt = (b: number) => `${(b / 1024 / 1024).toFixed(0)}MB`;
  const tick = () => {
    const m = process.memoryUsage();
    console.log(
      `[Zeros mem] rss=${fmt(m.rss)} heapUsed=${fmt(m.heapUsed)}/${fmt(m.heapTotal)} external=${fmt(m.external)} arrayBuffers=${fmt(m.arrayBuffers)}`,
    );
  };
  tick();
  const id = setInterval(tick, 600_000);
  if (typeof id.unref === "function") id.unref();
}

// ── Status command ────────────────────────────────────────

async function runStatus(port: number) {
  const url = `http://localhost:${port}/health`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    console.log("\n  \x1b[36mZeros\x1b[0m  Engine Status\n");
    console.log(`  Status:       \x1b[32m${data.status}\x1b[0m`);
    console.log(`  Version:      ${data.version}`);
    console.log(`  Connections:  ${data.connections}`);
    if (data.stats) {
      console.log(`  Selectors:    ${data.stats.selectors}`);
      console.log(`  CSS files:    ${data.stats.files}`);
      console.log(`  Tokens:       ${data.stats.tokens}`);
    }
    console.log("");
  } catch {
    console.log(
      "\n  \x1b[33mZeros engine is not running on port " + port + ".\x1b[0m",
    );
    console.log("  Start it with: \x1b[36mnpx Zeros serve\x1b[0m\n");
  }
}

// ── Help ──────────────────────────────────────────────────

function showHelp() {
  console.log(`
  \x1b[36mZeros\x1b[0m — Design tool that runs on your production code

  \x1b[1mUsage:\x1b[0m
    npx Zeros <command> [options]

  \x1b[1mCommands:\x1b[0m
    serve         Start the Zeros engine (design server)
    status        Check if the engine is running

  \x1b[1mServe Options:\x1b[0m
    --port <n>        Channel footprint base (stable 24193; beta 24203; dev 24293)
    --port-start <n>  First bridge port to try (default: --port)
    --port-span <n>   Consecutive bridge ports to try (default: ${ENGINE_PORT_SPAN})
    --root <dir>      Project root directory (default: auto-detect)

  \x1b[1mExamples:\x1b[0m
    npx Zeros serve
    npx Zeros serve --port 3001
    npx Zeros status
`);
}

// ── Main ──────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h") {
  showHelp();
  process.exit(0);
}

function getFlag(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : undefined;
}

if (command === "serve") {
  const port = getFlag("--port")
    ? parseInt(getFlag("--port")!, 10)
    : engineBasePort();
  const portStart = getFlag("--port-start")
    ? parseInt(getFlag("--port-start")!, 10)
    : port;
  const portSpan = getFlag("--port-span")
    ? parseInt(getFlag("--port-span")!, 10)
    : ENGINE_PORT_SPAN;
  const root = getFlag("--root");
  runServe(process.cwd(), port, portStart, portSpan, root);
} else if (command === "status") {
  const port = getFlag("--port")
    ? parseInt(getFlag("--port")!, 10)
    : engineBasePort();
  runStatus(port);
} else {
  console.log(`\n  \x1b[31mUnknown command:\x1b[0m ${command}\n`);
  showHelp();
  process.exit(1);
}
