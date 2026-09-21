#!/usr/bin/env node
import { spawn } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { readCloudHostRuntimeProfile } from "./cloud-runtime-profile.mjs";
import {
  CLOUD_WORKER_SUPERVISOR_AUDIENCE,
  CLOUD_WORKER_SUPERVISOR_SOCKET,
} from "./cloud-worker-supervisor.mjs";

const NODE = "/opt/zeros-runtime/bin/node";
const SUPERVISOR = "/opt/zeros-runtime/lib/zeros/cloud-worker-supervisor.mjs";

function rootPath(file, directory = false) {
  if (realpathSync(file) !== file) throw new Error("Unsafe cloud broker path");
  for (let current = file; ; current = path.dirname(current)) {
    const stat = lstatSync(current);
    if (
      stat.uid !== 0 ||
      stat.mode & 0o022 ||
      stat.isSymbolicLink() ||
      (current === file && !directory
        ? !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    )
      throw new Error("Unsafe cloud broker path");
    if (current === "/") break;
  }
}

export async function probeCloudWorkerSupervisor() {
  try {
    const stat = lstatSync(CLOUD_WORKER_SUPERVISOR_SOCKET);
    if (!stat.isSocket() || stat.uid !== 0 || stat.mode & 0o077)
      throw new Error("Unsafe cloud broker endpoint");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  return new Promise((resolve) => {
    const peer = connect(CLOUD_WORKER_SUPERVISOR_SOCKET);
    let source = "";
    const finish = (ready) => {
      peer.destroy();
      resolve(ready);
    };
    peer.setEncoding("utf8");
    peer.setTimeout(500, () => finish(false));
    peer.once("error", () => finish(false));
    peer.once("connect", () =>
      peer.write(
        `${JSON.stringify({ version: 1, audience: CLOUD_WORKER_SUPERVISOR_AUDIENCE, operation: "status" })}\n`,
      ),
    );
    peer.on("data", (chunk) => {
      source += chunk;
      if (Buffer.byteLength(source) > 1024) return finish(false);
      if (!source.endsWith("\n")) return;
      try {
        const response = JSON.parse(source);
        finish(
          response.version === 1 &&
            response.audience === CLOUD_WORKER_SUPERVISOR_AUDIENCE &&
            response.outcome === "ready",
        );
      } catch {
        finish(false);
      }
    });
    peer.once("end", () => finish(false));
  });
}

/** Start at most one candidate; the supervisor's kernel lock selects the
 * owner if multiple reconcilers arrive after a cold resume. A healthy broker
 * receives only a read-only probe, never a prepare or engine restart. */
export async function ensureCloudWorkerSupervisor({
  probe = probeCloudWorkerSupervisor,
  launch = () => {
    const child = spawn(NODE, [SUPERVISOR], {
      detached: true,
      stdio: "ignore",
      cwd: "/",
      env: {
        PATH: "/opt/zeros-runtime/bin:/usr/bin:/bin",
        HOME: "/root",
        LANG: "C.UTF-8",
      },
    });
    child.once("error", () => undefined);
    child.unref();
  },
  wait = delay,
} = {}) {
  if (await probe()) return;
  launch();
  for (let attempt = 0; attempt < 20; attempt++) {
    await wait(100);
    if (await probe()) return;
  }
  throw new Error("Cloud broker startup is unconfirmed");
}

async function main() {
  if (
    process.argv.length !== 2 ||
    process.platform !== "linux" ||
    process.getuid?.() !== 0
  )
    throw new Error("Cloud broker recovery requires fixed root admission");
  process.umask(0o077);
  if (readCloudHostRuntimeProfile().version < 2)
    throw new Error("Cloud broker recovery requires image profile v2");
  rootPath(NODE);
  rootPath(SUPERVISOR);
  rootPath("/run", true);
  try {
    mkdirSync("/run/zeros", { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  rootPath("/run/zeros", true);
  if ((lstatSync("/run/zeros").mode & 0o777) !== 0o700)
    throw new Error("Unsafe cloud broker directory");
  await ensureCloudWorkerSupervisor();
  process.stdout.write("ready\n");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    process.stderr.write("cloud broker recovery failed\n");
    process.exitCode = 1;
  });
