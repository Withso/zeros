#!/usr/bin/env node

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_DIAGNOSTIC_BYTES = 8_192;

function absolute(value, label) {
  if (
    !value ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be absolute`);
  }
  return path.normalize(value);
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function physicalDirectory(directory, label) {
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(directory) !== directory
  ) {
    throw new Error(`${label} is not a canonical physical directory`);
  }
  if (
    typeof process.getuid === "function" &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(`${label} has unsafe ownership or permissions`);
  }
}

function parseArguments() {
  const separator = process.argv.indexOf("--");
  if (separator < 0 || separator === process.argv.length - 1) {
    throw new Error("container worker target is missing");
  }
  const options = process.argv.slice(2, separator);
  if (
    options.length !== 6 ||
    options[0] !== "--engine" ||
    options[2] !== "--state" ||
    options[4] !== "--socket"
  ) {
    throw new Error("container worker options are invalid");
  }
  const engine = absolute(options[1], "container engine");
  const state = absolute(options[3], "container state");
  const socket = absolute(options[5], "container socket");
  if (!inside(socket, state) || socket !== path.join(state, "podman.sock")) {
    throw new Error("container socket is outside its exact private endpoint");
  }
  const engineStat = lstatSync(engine);
  if (
    !engineStat.isFile() ||
    engineStat.isSymbolicLink() ||
    realpathSync(engine) !== engine ||
    (engineStat.mode & 0o111) === 0
  ) {
    throw new Error("container engine is not a canonical executable");
  }
  physicalDirectory(state, "container state");
  if (!path.isAbsolute(process.argv[separator + 1])) {
    throw new Error("container worker target must be absolute");
  }
  return { engine, state, socket, target: process.argv.slice(separator + 1) };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function prepareState(state, socket) {
  const runtime = path.join(state, "runtime");
  const graph = path.join(state, "storage");
  const temporary = path.join(state, "tmp");
  const configuration = path.join(state, "config");
  const data = path.join(state, "data");
  for (const directory of [runtime, temporary, configuration, data]) {
    rmSync(directory, { recursive: true, force: true });
    mkdirSync(directory, { recursive: false, mode: 0o700 });
    physicalDirectory(directory, "container worker directory");
    chmodSync(directory, 0o700);
  }
  if (!existsSync(graph)) mkdirSync(graph, { recursive: false, mode: 0o700 });
  physicalDirectory(graph, "container storage");
  chmodSync(graph, 0o700);
  rmSync(socket, { force: true });
  const storageConfig = path.join(configuration, "storage.conf");
  const containersConfig = path.join(configuration, "containers.conf");
  writeFileSync(
    storageConfig,
    [
      "[storage]",
      'driver = "vfs"',
      `runroot = ${tomlString(runtime)}`,
      `graphroot = ${tomlString(graph)}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  writeFileSync(
    containersConfig,
    [
      "[containers]",
      'cgroups = "disabled"',
      "pids_limit = 1024",
      "",
      "[engine]",
      'cgroup_manager = "cgroupfs"',
      'events_logger = "file"',
      "service_timeout = 0",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    runtime,
    graph,
    data,
    temporary,
    storageConfig,
    containersConfig,
  };
}

async function ping(socket) {
  return new Promise((resolve) => {
    const peer = connect(socket);
    let response = "";
    const finish = (ready) => {
      peer.destroy();
      resolve(ready);
    };
    peer.setEncoding("utf8");
    peer.setTimeout(500, () => finish(false));
    peer.once("connect", () =>
      peer.write(
        "GET /_ping HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      ),
    );
    peer.on("data", (chunk) => {
      response = (response + chunk).slice(-4_096);
    });
    peer.once("end", () => finish(/\r\n\r\nOK\s*$/s.test(response)));
    peer.once("error", () => finish(false));
  });
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    delay(timeoutMs).then(() => false),
  ]);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, STOP_TIMEOUT_MS)) return;
  child.kill("SIGKILL");
  await waitForExit(child, STOP_TIMEOUT_MS);
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error("embedded container workers require Linux");
  }
  const request = parseArguments();
  const state = prepareState(request.state, request.socket);
  const runtimeIdentity = userInfo();
  const engineEnvironment = {
    ...process.env,
    // Privileged supervisors retain their original login variables after
    // setuid/setpriv. Podman consults these while choosing its rootless user;
    // stale `root` values make it build or join the wrong user namespace.
    USER: runtimeIdentity.username,
    LOGNAME: runtimeIdentity.username,
    HOME: request.state,
    XDG_RUNTIME_DIR: state.runtime,
    XDG_CONFIG_HOME: path.join(request.state, "config"),
    XDG_DATA_HOME: state.data,
    TMPDIR: state.temporary,
    CONTAINERS_STORAGE_CONF: state.storageConfig,
    CONTAINERS_CONF: state.containersConfig,
  };
  const worker = spawn(
    request.engine,
    [
      "--log-level=error",
      "--root",
      state.graph,
      "--runroot",
      state.runtime,
      "--tmpdir",
      state.temporary,
      "--storage-driver=vfs",
      "--cgroup-manager=cgroupfs",
      "--events-backend=file",
      "system",
      "service",
      "--time=0",
      `unix://${request.socket}`,
    ],
    {
      cwd: request.state,
      env: engineEnvironment,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let diagnostic = "";
  let workerSpawnError = false;
  const workerExit = new Promise((resolve) => {
    worker.once("error", () => {
      workerSpawnError = true;
      resolve({ code: null, signal: null });
    });
    worker.once("exit", (code, signal) => resolve({ code, signal }));
  });
  worker.stderr?.setEncoding("utf8");
  worker.stderr?.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-MAX_DIAGNOSTIC_BYTES);
  });

  let target;
  try {
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (
      Date.now() < deadline &&
      !workerSpawnError &&
      worker.exitCode === null &&
      worker.signalCode === null
    ) {
      if (existsSync(request.socket) && (await ping(request.socket))) {
        ready = true;
        break;
      }
      await delay(25);
    }
    if (!ready) {
      throw new Error(
        `private Podman service did not become ready${diagnostic ? ": see redacted worker diagnostics" : ""}`,
      );
    }
    chmodSync(request.socket, 0o600);
    target = spawn(request.target[0], request.target.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });
    let terminating = false;
    const forward = (signal) => {
      if (terminating && signal !== "SIGKILL") return;
      terminating = true;
      target?.kill(signal);
    };
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.on(signal, () => forward(signal));
    }
    const outcome = await Promise.race([
      new Promise((resolve, reject) => {
        target.once("error", reject);
        target.once("exit", (code, signal) =>
          resolve({ source: "target", code, signal }),
        );
      }),
      workerExit.then(({ code, signal }) => ({
        source: "worker",
        code,
        signal,
      })),
    ]);
    if (outcome.source === "worker") {
      target.kill("SIGTERM");
      await waitForExit(target, STOP_TIMEOUT_MS);
      throw new Error(
        `private Podman service exited unexpectedly (${outcome.code ?? outcome.signal})${diagnostic ? "; diagnostics redacted" : ""}`,
      );
    }
    if (typeof outcome.code === "number") process.exitCode = outcome.code;
    else if (outcome.signal) process.exitCode = 128;
  } finally {
    await stop(target);
    await stop(worker);
    rmSync(request.socket, { force: true });
    // Reject a malicious storage symlink swap before consulting diagnostics or
    // returning control. The durable root itself must remain a physical dir.
    physicalDirectory(request.state, "container state");
  }
}

await main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[zsr-container-worker] ${message.slice(0, 1_000)}\n`);
  process.exitCode = 125;
});
