import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const LAUNCHER = fileURLToPath(
  new URL("../cloud-container-worker.mjs", import.meta.url),
);

describe.skipIf(process.platform !== "linux")("cloud container worker", () => {
  let root: string;
  let state: string;
  let socket: string;
  let engine: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "zeros-cloud-container-test-"));
    state = path.join(root, "state");
    socket = path.join(state, "podman.sock");
    engine = path.join(root, "podman");
    await mkdir(state, { mode: 0o700 });
    await writeFile(
      engine,
      `#!/usr/bin/env node
const { createServer } = require("node:net");
const { writeFileSync } = require("node:fs");
const path = require("node:path");
const socket = process.argv.find((value) => value.startsWith("unix://"))?.slice(7);
if (!socket) process.exit(91);
if (process.argv.some((value) => value.includes("ignore_chown_errors"))) process.exit(92);
const runroot = process.argv[process.argv.indexOf("--runroot") + 1];
writeFileSync(path.join(path.dirname(socket), "runroot.json"), JSON.stringify({runroot, xdg: process.env.XDG_RUNTIME_DIR}));
// Podman creates its own Unix sockets inside runroot and rejects longer paths.
if (runroot.length > 50) { process.stderr.write("runroot exceeds 50 characters"); process.exit(93); }
writeFileSync(path.join(path.dirname(socket), "engine-env.json"), JSON.stringify({
  uid: process.getuid(),
  user: process.env.USER,
  logname: process.env.LOGNAME,
  remote: process.env.CONTAINER_HOST ?? null,
  connection: process.env.CONTAINER_CONNECTION ?? null,
  docker: process.env.DOCKER_HOST ?? null,
}));
const server = createServer((peer) => {
  peer.end("HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\nOK");
});
server.listen(socket);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
`,
      { mode: 0o700 },
    );
    await chmod(engine, 0o700);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("starts the private API before the target and removes the endpoint", async () => {
    const started = Date.now();
    const marker = path.join(root, "target.json");
    const target = [
      process.execPath,
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({docker: process.env.DOCKER_HOST, container: process.env.CONTAINER_HOST}))`,
    ];
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        socket,
        "--",
        ...target,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          // A privileged supervisor commonly retains these values after it
          // drops uid. Podman treats them as identity inputs and otherwise
          // attempts the wrong rootless namespace.
          USER: "root",
          LOGNAME: "root",
          DOCKER_HOST: `unix://${socket}`,
          CONTAINER_HOST: `unix://${socket}`,
          CONTAINER_CONNECTION: "must-not-select-a-remote-daemon",
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
      docker: `unix://${socket}`,
      container: `unix://${socket}`,
    });
    const identity = os.userInfo();
    expect(
      JSON.parse(await readFile(path.join(state, "engine-env.json"), "utf8")),
    ).toEqual({
      uid: process.getuid?.(),
      user: identity.username,
      logname: identity.username,
      remote: null,
      connection: null,
      docker: null,
    });
    expect(
      await readFile(path.join(state, "config", "storage.conf"), "utf8"),
    ).not.toContain("ignore_chown_errors");
    expect(await readFile(path.join(state, "config", "containers.conf"), "utf8"))
      .toContain('runtime = "crun"');
    await expect(readFile(socket)).rejects.toMatchObject({ code: "ENOENT" });
    const runtime = JSON.parse(await readFile(path.join(state, "runroot.json"), "utf8"));
    expect(runtime.runroot.length).toBeLessThanOrEqual(50);
    expect(runtime.xdg).toBe(runtime.runroot);
    expect(runtime.runroot).toMatch(/^\/tmp\/zeros-cr-/);
    await expect(stat(runtime.runroot)).rejects.toMatchObject({ code: "ENOENT" });
    // The OCI database binds durable image/container state to this runtime
    // location, including after a service restart in the same execution.
    const restarted = spawnSync(process.execPath, [LAUNCHER, "--engine", engine,
      "--state", state, "--socket", socket, "--", ...target],
    { cwd: root, env: process.env, encoding: "utf8", timeout: 10000 });
    expect(restarted.status, restarted.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(state, "runroot.json"), "utf8"))).toEqual(runtime);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("rejects option smuggling and a non-exact socket", () => {
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        path.join(state, "alternate.sock"),
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toMatch(/exact private endpoint/);
  });

  it("retains the active service and its socket when an overlapping command is rejected", async () => {
    const marker = path.join(root, "active");
    const args = [LAUNCHER, "--engine", engine, "--state", state, "--socket", socket, "--", process.execPath, "-e"];
    const first = spawn(process.execPath, [...args,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready');process.stdin.resume();process.stdin.on('end',()=>process.exit(0))`,
    ], { cwd: root, env: process.env, stdio: ["pipe", "ignore", "pipe"] });
    const exited = once(first, "exit");
    try {
      await expect.poll(() => readFile(marker, "utf8").catch(() => null), { timeout: 3000 }).toBe("ready");
      const metadata = await stat(socket);
      const second = spawnSync(process.execPath, [...args, "process.exit(0)"],
        { cwd: root, env: process.env, encoding: "utf8", timeout: 3000 });
      expect(second.status).toBe(125);
      expect(second.stderr).toMatch(/service is busy/);
      expect((await stat(socket)).ino).toBe(metadata.ino);
      expect(first.exitCode).toBeNull();
    } finally {
      first.stdin.end();
      const finished = await Promise.race([exited.then(() => true), delay(3000).then(() => false)]);
      if (!finished) first.kill("SIGKILL");
      await exited;
    }
    expect(first.exitCode).toBe(0);
    await expect(stat(socket)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a service-lock alias without touching its target", async () => {
    const canary = path.join(root, "lock-canary");
    await writeFile(canary, "unchanged");
    await symlink(canary, path.join(state, "service.lock"));
    const result = spawnSync(process.execPath, [LAUNCHER, "--engine", engine, "--state", state,
      "--socket", socket, "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8", timeout: 3000 });
    expect(result.status).toBe(125);
    expect(await readFile(canary, "utf8")).toBe("unchanged");
  });

  it("serves a short private endpoint when the durable session path exceeds Unix socket limits", async () => {
    const longState = path.join(root, "x".repeat(128), "container-worker");
    await mkdir(longState, { recursive: true, mode: 0o700 });
    const endpoint = path.join(root, "endpoint");
    await mkdir(endpoint, { mode: 0o700 });
    const shortSocket = path.join(endpoint, "podman.sock");
    const result = spawnSync(process.execPath, [LAUNCHER, "--engine", engine, "--state", longState,
      "--socket", shortSocket, "--", process.execPath, "-e", "process.exit(0)"], { encoding: "utf8", timeout: 3000 });
    expect(result.status, result.stderr).toBe(0);
    await expect(stat(shortSocket)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not disclose private engine diagnostics", async () => {
    const secret = path.join(root, "credential-secret");
    await writeFile(
      engine,
      `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(secret)} >&2\nexit 92\n`,
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [
        LAUNCHER,
        "--engine",
        engine,
        "--state",
        state,
        "--socket",
        socket,
        "--",
        process.execPath,
        "-e",
        "process.exit(0)",
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(result.status).toBe(125);
    expect(result.stderr).toContain("diagnostics");
    expect(result.stderr).not.toContain(secret);
  });
});
