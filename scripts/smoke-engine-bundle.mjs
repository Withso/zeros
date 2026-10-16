#!/usr/bin/env node
// Load the real CommonJS engine graph. --help and node --check do not do this.
// Build first with pnpm build:engine, or pass the staged runtime's dist-engine.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

class SmokeFailure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function smoke(dist, timeoutMs) {
  const sandbox = await mkdtemp(join(tmpdir(), "zeros-engine-bundle-smoke-"));
  let child, closed, deadline, readyTimer;
  const signals = [];
  try {
    for (const name of [
      "repo",
      "home",
      "data",
      "settings",
      "workspaces",
      "tmp",
    ])
      await mkdir(join(sandbox, name));
    const port = await freePort();
    child = spawn(
      process.execPath,
      [
        join(dist, "cli.js"),
        "serve",
        "--port",
        String(port),
        "--port-start",
        String(port),
        "--port-span",
        "1",
        "--root",
        join(sandbox, "repo"),
      ],
      {
        cwd: dirname(dist),
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe", "pipe"],
        // Never enroll a real workspace or inherit credentials/configuration.
        env: {
          PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
          HOME: join(sandbox, "home"),
          TMPDIR: join(sandbox, "tmp"),
          XDG_CONFIG_HOME: join(sandbox, "home", ".config"),
          XDG_CACHE_HOME: join(sandbox, "home", ".cache"),
          LANG: "C.UTF-8",
          CI: "true",
          ZEROS_DEV: "0",
          ZEROS_RUNTIME_MODE: "packaged",
          ZEROS_DATA_DIR: join(sandbox, "data"),
          ZEROS_USER_SETTINGS_DIR: join(sandbox, "settings"),
          ZEROS_WORKSPACES_DIR: join(sandbox, "workspaces"),
          ZEROS_REQUIRE_ACCOUNT: "0",
          ZEROS_CONTROL_FD: "3",
        },
      },
    );
    closed = new Promise((done) => child.once("close", done));
    // Drain the private local-authority pipe without logging its bearer.
    child.stdio[3].resume();
    await new Promise((ready, reject) => {
      const fail = (message, code) => reject(new SmokeFailure(message, code));
      deadline = setTimeout(
        () => fail("timed out waiting for Engine ready"),
        timeoutMs,
      );
      child.once("error", () => fail("could not spawn the bundled engine"));
      child.once("exit", (code, signal) =>
        fail(`engine exited before readiness (code=${code}, signal=${signal})`),
      );
      for (const [signal, code] of [
        ["SIGINT", 130],
        ["SIGTERM", 143],
      ]) {
        const handler = () => fail("startup check cancelled", code);
        signals.push([signal, handler]);
        process.once(signal, handler);
      }
      const readyPattern = new RegExp(`\\bEngine ready on port ${port}\\b`);
      for (const stream of [child.stdout, child.stderr]) {
        let tail = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk) => {
          tail = (tail + chunk).slice(-64 * 1024);
          const failure = /unhandledRejection|uncaughtException/i.exec(tail);
          if (failure)
            return fail(`engine reported ${failure[0]} during startup`);
          // A logged ready line followed by immediate exit/rejection is a failure.
          if (!readyTimer && readyPattern.test(tail))
            readyTimer = setTimeout(ready, 250);
        });
      }
    });
  } finally {
    clearTimeout(deadline);
    clearTimeout(readyTimer);
    if (child?.pid) {
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    await closed;
    for (const [signal, handler] of signals)
      process.removeListener(signal, handler);
    await rm(sandbox, { recursive: true, force: true });
  }
}

try {
  const { values } = parseArgs({
    options: {
      "dist-engine": { type: "string" },
      "timeout-ms": { type: "string", default: "60000" },
      help: { type: "boolean" },
    },
    strict: true,
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/smoke-engine-bundle.mjs [--dist-engine <directory>] [--timeout-ms <milliseconds>]",
    );
  } else {
    const timeoutMs = Number(values["timeout-ms"]);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 60_000
    )
      throw new SmokeFailure("timeout-ms must be between 1 and 60000");
    const dist =
      values["dist-engine"] ??
      fileURLToPath(new URL("../dist-engine", import.meta.url));
    await smoke(resolve(dist), timeoutMs);
    console.log("[smoke-engine-bundle] Engine ready; startup passed.");
  }
} catch (error) {
  // Keep CI output free of paths, child stderr, environment and bearer values.
  console.error(
    `[smoke-engine-bundle] ${error instanceof SmokeFailure ? error.message : "could not run the startup check"}`,
  );
  process.exitCode = error instanceof SmokeFailure ? error.exitCode : 1;
}
