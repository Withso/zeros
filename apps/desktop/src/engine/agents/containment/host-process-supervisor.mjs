#!/usr/bin/env node

// Unrestricted native-host lifecycle supervisor.
//
// This process does not apply a sandbox, rewrite provider configuration, or
// alter the target's environment. Its only jobs are to publish a durable
// process-group claim before the target starts, keep the target in the same
// process group, and kill that group if the owning engine disappears.

import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const VERSION = 1;
const INTERNAL_ENV_PREFIX = "ZEROS_HOST_SUPERVISOR_";
const MAX_PENDING_BYTES = 64 * 1024;

function fail(message) {
  process.stderr.write(`[zeros-host-supervisor] ${message}\n`);
  process.exitCode = 125;
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readPending(file) {
  const handle = openSync(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const opened = fstatSync(handle);
    const linked = lstatSync(file);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      linked.isSymbolicLink() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.size <= 0 ||
      opened.size > MAX_PENDING_BYTES ||
      (process.platform !== "win32" && (opened.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) {
      throw new Error("pending launch is not a trusted private file");
    }
    return JSON.parse(readFileSync(handle, "utf8"));
  } finally {
    closeSync(handle);
  }
}

function validatePrivatePath(file, parent, suffix) {
  if (
    typeof file !== "string" ||
    !path.isAbsolute(file) ||
    file.includes("\0") ||
    path.dirname(file) !== parent ||
    !path.basename(file).endsWith(suffix)
  ) {
    throw new Error("invalid lifecycle path");
  }
}

function restoreTargetEnvironment() {
  const encoded = process.env[`${INTERNAL_ENV_PREFIX}ORIGINAL_ENV`];
  let original = {};
  if (encoded) {
    const decoded = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    );
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("invalid original environment descriptor");
    }
    original = decoded;
  }
  const target = { ...process.env };
  for (const name of Object.keys(target)) {
    if (name.startsWith(INTERNAL_ENV_PREFIX)) delete target[name];
  }
  for (const [name, value] of Object.entries(original)) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      name.includes("\0") ||
      value.includes("\0")
    ) {
      throw new Error("invalid original environment entry");
    }
    target[name] = value;
  }
  if (original.ELECTRON_RUN_AS_NODE === undefined) {
    delete target.ELECTRON_RUN_AS_NODE;
  }
  return target;
}

async function run() {
  const pendingPath = option("--pending");
  const claimPath = option("--claim");
  const domainPath = option("--domain");
  const generation = option("--generation");
  const token = option("--token");
  const expectedOwnerPid = Number(option("--owner-pid"));
  const expectedParentPid = Number(option("--parent-pid"));
  const separator = process.argv.indexOf("--");
  const targetCommand =
    separator >= 0 ? process.argv[separator + 1] : undefined;
  const targetArgs = separator >= 0 ? process.argv.slice(separator + 2) : [];
  if (
    !pendingPath ||
    !claimPath ||
    !domainPath ||
    typeof generation !== "string" ||
    !/^host-[0-9a-f-]{36}$/i.test(generation) ||
    typeof token !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(token) ||
    !Number.isSafeInteger(expectedOwnerPid) ||
    expectedOwnerPid <= 0 ||
    !Number.isSafeInteger(expectedParentPid) ||
    expectedParentPid <= 0 ||
    process.ppid !== expectedParentPid ||
    typeof targetCommand !== "string" ||
    targetCommand.length === 0 ||
    targetCommand.includes("\0") ||
    targetArgs.some((argument) => argument.includes("\0"))
  ) {
    throw new Error("invalid lifecycle launch identity");
  }

  const generationRoot = path.dirname(path.dirname(pendingPath));
  const commandsRoot = path.join(generationRoot, "commands");
  const claimsRoot = path.join(generationRoot, "claims");
  const domainsRoot = path.join(generationRoot, "domains");
  const generationMetadata = lstatSync(generationRoot);
  if (
    path.basename(generationRoot) !== generation ||
    !generationMetadata.isDirectory() ||
    generationMetadata.isSymbolicLink()
  ) {
    throw new Error("lifecycle generation is not a physical directory");
  }
  const canonicalGenerationRoot = realpathSync(generationRoot);
  if (
    realpathSync(commandsRoot) !==
      path.join(canonicalGenerationRoot, "commands") ||
    realpathSync(claimsRoot) !== path.join(canonicalGenerationRoot, "claims") ||
    realpathSync(domainsRoot) !== path.join(canonicalGenerationRoot, "domains")
  ) {
    throw new Error("lifecycle directories are not physical children");
  }
  validatePrivatePath(pendingPath, commandsRoot, ".json");
  validatePrivatePath(claimPath, claimsRoot, ".json");
  validatePrivatePath(domainPath, domainsRoot, ".json");

  // Atomic ownership hand-off: boot recovery either removes the command first
  // (and this process cannot start the target) or observes the claim/domain.
  renameSync(pendingPath, claimPath);
  const pending = readPending(claimPath);
  if (
    pending.version !== VERSION ||
    pending.generation !== generation ||
    pending.token !== token ||
    pending.ownerPid !== expectedOwnerPid ||
    !Number.isSafeInteger(pending.createdAt) ||
    Object.keys(pending).sort().join("\0") !==
      "createdAt\0generation\0ownerPid\0token\0version"
  ) {
    throw new Error("pending launch identity changed");
  }

  const temporaryDomain = `${domainPath}.tmp-${process.pid}`;
  writeFileSync(
    temporaryDomain,
    JSON.stringify({
      version: VERSION,
      kind: "supervisor",
      generation,
      token,
      pid: process.pid,
      createdAt: pending.createdAt,
    }),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  chmodSync(temporaryDomain, 0o600);
  renameSync(temporaryDomain, domainPath);
  unlinkSync(claimPath);

  const targetEnv = restoreTargetEnvironment();
  let child;
  let parentWatch;
  let stopping = false;
  const stop = (signal) => {
    if (stopping && signal !== "SIGKILL") return;
    stopping = true;
    try {
      child?.kill(signal);
    } catch {
      // The target already exited. The boundary still proves the whole group.
    }
  };
  const handlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => stop(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  parentWatch = setInterval(() => {
    let ownerAlive = true;
    try {
      process.kill(expectedOwnerPid, 0);
    } catch (error) {
      ownerAlive = error?.code === "EPERM";
    }
    if (process.ppid === expectedParentPid && ownerAlive) return;
    if (process.platform === "win32") {
      if (child?.pid) {
        const killer = spawn(
          "taskkill",
          ["/pid", String(child.pid), "/t", "/f"],
          { stdio: "ignore", windowsHide: true },
        );
        killer.once("close", () => process.exit(125));
        killer.once("error", () => {
          stop("SIGKILL");
          process.exit(125);
        });
      } else {
        process.exit(125);
      }
      clearInterval(parentWatch);
      return;
    }
    // The supervisor is the process-group leader. SIGKILL makes parent loss
    // atomic for every non-escaped provider descendant, including ourselves.
    process.kill(-process.pid, "SIGKILL");
  }, 50);
  parentWatch.unref?.();

  child = spawn(targetCommand, targetArgs, {
    cwd: process.cwd(),
    env: targetEnv,
    stdio: "inherit",
    detached: false,
    windowsHide: true,
  });
  const exit = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("exit", (code, signal) => finish({ code, signal }));
    child.once("error", () => finish({ code: 125, signal: null }));
  });
  clearInterval(parentWatch);
  for (const [signal, handler] of handlers) process.off(signal, handler);
  if (typeof exit.code === "number") process.exitCode = exit.code;
  else if (exit.signal && process.platform !== "win32") {
    process.kill(process.pid, exit.signal);
  } else {
    process.exitCode = 128;
  }
}

await run().catch((error) => {
  fail(error instanceof Error ? error.message.slice(0, 1_000) : String(error));
});
