#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, connect } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CONTRACT_VERSION = 1;
const STATE_ROOT = "/var/lib/zeros-zsr/sessions";
const USERNS_ROOT = "/var/lib/zeros-zsr/userns";
const USERNS_RUNTIME_ROOT = "/run/zsr-u";
const WORKER = "/opt/zeros-zsr/zsr-container-worker.mjs";
const NODE = "/usr/bin/node";
const PODMAN = "/usr/bin/podman";
const BWRAP = "/usr/bin/bwrap";
const RUNUSER = "/usr/sbin/runuser";
const NFT = "/usr/sbin/nft";
const ORBSTACK_RESOLV_CONF = "/opt/orbstack-guest/etc/resolv.conf";
const READY_TIMEOUT_MS = 45_000;
const STOP_TIMEOUT_MS = 5_000;
const MAX_DESCRIPTOR_BYTES = 256 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8_192;
let nftSequence = 0;

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${label} has unsupported fields`);
  }
}

function absolute(value, label) {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    value.includes("\0") ||
    /[\r\n]/.test(value)
  ) {
    fail(`${label} must be an absolute path`);
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

function physical(candidate, kind, label) {
  const normalized = absolute(candidate, label);
  const stat = lstatSync(normalized);
  if (stat.isSymbolicLink() || realpathSync(normalized) !== normalized) {
    fail(`${label} must be canonical and symlink-free`);
  }
  if (kind === "directory" && !stat.isDirectory()) {
    fail(`${label} must be a directory`);
  }
  if (kind === "file" && !stat.isFile()) fail(`${label} must be a file`);
  return { path: normalized, stat };
}

function readDescriptor(descriptorPath) {
  const descriptorFile = physical(descriptorPath, "file", "descriptor");
  if (
    descriptorFile.stat.size > MAX_DESCRIPTOR_BYTES ||
    (descriptorFile.stat.mode & 0o077) !== 0
  ) {
    fail("descriptor permissions or size are unsafe");
  }
  const value = JSON.parse(readFileSync(descriptorFile.path, "utf8"));
  exactKeys(
    value,
    [
      "executionId",
      "generation",
      "sessionKey",
      "uid",
      "gid",
      "version",
      "workspaceRoot",
      "writeRoots",
      "protectedRoots",
    ],
    "descriptor",
  );
  if (
    value.version !== CONTRACT_VERSION ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.executionId) ||
    !/^[A-Za-z0-9_-]{20,160}$/.test(value.generation) ||
    !/^[a-f0-9]{32}$/.test(value.sessionKey) ||
    !Number.isInteger(value.uid) ||
    value.uid < 1 ||
    !Number.isInteger(value.gid) ||
    value.gid < 1
  ) {
    fail("descriptor identity is invalid");
  }
  const workspace = physical(
    value.workspaceRoot,
    "directory",
    "workspace root",
  ).path;
  if (
    !Array.isArray(value.writeRoots) ||
    value.writeRoots.length < 1 ||
    value.writeRoots.length > 64 ||
    !Array.isArray(value.protectedRoots) ||
    value.protectedRoots.length > 128
  ) {
    fail("descriptor root sets are invalid");
  }
  const writeRoots = [
    ...new Set(
      value.writeRoots.map(
        (candidate, index) =>
          physical(candidate, "directory", `write root ${index}`).path,
      ),
    ),
  ];
  if (!writeRoots.includes(workspace)) {
    fail("workspace root is absent from write roots");
  }
  const protectedRoots = [
    ...new Set(
      value.protectedRoots.map((candidate, index) => {
        const resolved = physical(
          candidate,
          "directory",
          `protected root ${index}`,
        ).path;
        if (!writeRoots.some((root) => inside(resolved, root))) {
          fail("protected root is outside writable projections");
        }
        return resolved;
      }),
    ),
  ];
  if (protectedRoots.some((root) => root === workspace)) {
    fail("workspace root cannot be the protected subtree");
  }
  return {
    executionId: value.executionId,
    generation: value.generation,
    sessionKey: value.sessionKey,
    uid: value.uid,
    gid: value.gid,
    workspace,
    writeRoots,
    protectedRoots,
  };
}

function directoryArguments(destinations) {
  const directories = new Set();
  for (const destination of destinations) {
    let current = path.dirname(destination);
    while (current !== path.parse(current).root) {
      directories.add(current);
      current = path.dirname(current);
    }
  }
  return [...directories]
    .sort((left, right) => left.length - right.length)
    .flatMap((directory) => ["--dir", directory]);
}

function nft(input, allowFailure = false) {
  nftSequence += 1;
  const transaction = `/run/zeros-zsr-nft-${process.pid}-${nftSequence}.nft`;
  writeFileSync(transaction, input, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  let result;
  try {
    result = spawnSync(NFT, ["-f", transaction], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    rmSync(transaction, { force: true });
  }
  if (!allowFailure && result.status !== 0) {
    if (process.env.SRT_DEBUG === "1") {
      process.stderr.write(
        `[zsr-orbstack-container-host] nft diagnostic: ${String(result.stderr).slice(-2_048)}\n`,
      );
    }
    fail("private worker firewall could not be configured");
  }
}

function resetFirewall(port = null) {
  nft("delete table inet zeros_zsr\n", true);
  nft(`table inet zeros_zsr {
  set leased_tcp { type inet_service; flags timeout; timeout 10s; }
  set leased_udp { type inet_service; flags timeout; timeout 10s; }
  chain input {
    type filter hook input priority -200; policy accept;
    ct state established,related accept
    tcp dport @leased_tcp accept
    tcp flags & (fin|syn|rst|ack) == syn drop
    udp dport @leased_udp accept
    meta l4proto udp drop
  }
}
${port === null ? "" : `add element inet zeros_zsr leased_tcp { ${port} timeout 10s }`}
`);
}

function refreshFirewall(port) {
  nft(`delete element inet zeros_zsr leased_tcp { ${port} }
add element inet zeros_zsr leased_tcp { ${port} timeout 10s }
`);
}

function clearFirewall() {
  // Keep the dedicated machine default-deny after a session ends. Deleting
  // the table would let a surviving container or unrelated listener ride
  // OrbStack's automatic localhost forwarding without a ZSR lease.
  resetFirewall();
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function waitForGroup(pgid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pgid)) return true;
    await delay(25);
  }
  return !processGroupExists(pgid);
}

async function stopGroup(pgid) {
  if (!processGroupExists(pgid)) return;
  try {
    process.kill(-pgid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForGroup(pgid, STOP_TIMEOUT_MS)) return;
  try {
    process.kill(-pgid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForGroup(pgid, STOP_TIMEOUT_MS))) {
    fail("private worker process domain survived forced teardown");
  }
}

async function bridge(socketPath, sessionKey) {
  const socket = absolute(socketPath, "private Podman socket");
  if (!/^[a-f0-9]{32}$/.test(sessionKey)) {
    fail("private bridge session identity is invalid");
  }
  const server = createServer({ allowHalfOpen: true }, (peer) => {
    let request = Buffer.alloc(0);
    let routed = false;
    const timeout = setTimeout(() => peer.destroy(), 5_000);
    const onData = (chunk) => {
      if (routed) return;
      request = Buffer.concat([request, chunk]);
      if (request.byteLength > 64 * 1024) {
        clearTimeout(timeout);
        peer.destroy();
        return;
      }
      const headerEnd = request.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      routed = true;
      clearTimeout(timeout);
      peer.off("data", onData);
      const firstLineEnd = request.indexOf("\r\n");
      const firstLine = request
        .subarray(0, firstLineEnd < 0 ? headerEnd : firstLineEnd)
        .toString("ascii");
      const attestation =
        /^GET \/_zeros_zsr\/attest\/([a-f0-9]{64}) HTTP\/1\.[01]$/.exec(
          firstLine,
        );
      if (attestation) {
        const proof = createHmac("sha256", sessionKey)
          .update(attestation[1])
          .digest("hex");
        peer.end(
          `HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 64\r\nConnection: close\r\n\r\n${proof}`,
        );
        return;
      }
      const upstream = connect({ path: socket, allowHalfOpen: true });
      peer.on("error", () => upstream.destroy());
      upstream.on("error", () => peer.destroy());
      peer.on("end", () => upstream.end());
      upstream.on("end", () => peer.end());
      upstream.write(request);
      peer.pipe(upstream, { end: false });
      upstream.pipe(peer, { end: false });
    };
    peer.on("data", onData);
    peer.once("end", () => {
      if (!routed) peer.destroy();
    });
    peer.once("error", () => clearTimeout(timeout));
    peer.once("close", () => clearTimeout(timeout));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") fail("missing bridge port");
  process.stdout.write(
    `${JSON.stringify({ version: CONTRACT_VERSION, bridgeReady: true, port: address.port })}\n`,
  );
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
  await new Promise((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
}

/** Carry one Mac-side proxy connection over OrbStack's signed command channel.
 * Isolated machines intentionally do not promise a stable Mac-routable IP when
 * another isolated machine is created or removed. The command channel remains
 * bound to the exact machine name selected by the signed `orb` client. */
async function relay(rawPort) {
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) {
    fail("private bridge relay port is invalid");
  }
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port > 65_535) {
    fail("private bridge relay port is invalid");
  }
  const upstream = connect({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  await new Promise((resolve, reject) => {
    const failRelay = (error) => {
      upstream.destroy();
      reject(error);
    };
    upstream.once("error", failRelay);
    process.stdin.once("error", failRelay);
    process.stdout.once("error", failRelay);
    upstream.once("connect", () => {
      process.stdin.pipe(upstream);
      upstream.pipe(process.stdout, { end: false });
    });
    upstream.once("end", () => {
      // A Docker HTTP server may close its response half while the client
      // keeps the request half open for connection reuse. Complete that
      // half-close here so the relay exits and the Mac proxy can deliver EOF
      // instead of leaving both endpoints waiting on one another forever.
      process.stdin.unpipe(upstream);
      process.stdin.pause();
      upstream.end();
    });
    upstream.once("close", (hadError) => {
      if (!hadError) resolve();
    });
  });
}

function workerArguments(descriptor, workerState, usernsState, usernsRuntime) {
  const mountDestinations = [
    ...descriptor.writeRoots,
    ...descriptor.protectedRoots,
  ];
  const bwrap = [
    BWRAP,
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-cgroup-try",
    "--ro-bind",
    "/usr",
    "/usr",
    "--symlink",
    "usr/bin",
    "/bin",
    "--symlink",
    "usr/sbin",
    "/sbin",
    "--symlink",
    "usr/lib",
    "/lib",
    "--ro-bind",
    "/etc",
    "/etc",
    "--ro-bind",
    "/opt/zeros-zsr",
    "/opt/zeros-zsr",
    "--dir",
    "/opt/orbstack-guest",
    "--dir",
    "/opt/orbstack-guest/etc",
    "--ro-bind",
    ORBSTACK_RESOLV_CONF,
    ORBSTACK_RESOLV_CONF,
    "--ro-bind",
    "/sys",
    "/sys",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--dev-bind",
    "/dev/net/tun",
    "/dev/net/tun",
    "--dir",
    "/run",
    "--dir",
    "/run/lock",
    "--dir",
    "/var",
    "--symlink",
    "../run",
    "/var/run",
    "--symlink",
    "../run/lock",
    "/var/lock",
    "--tmpfs",
    "/var/tmp",
    "--tmpfs",
    "/tmp",
    "--bind",
    workerState,
    "/state",
    ...directoryArguments(mountDestinations),
    ...descriptor.writeRoots.flatMap((root) => ["--bind", root, root]),
    ...descriptor.protectedRoots.flatMap((root) => ["--ro-bind", root, root]),
    "--chdir",
    descriptor.workspace,
    NODE,
    WORKER,
    "--engine",
    PODMAN,
    "--state",
    "/state",
    "--socket",
    "/state/podman.sock",
    "--",
    NODE,
    WORKER.replace(
      "zsr-container-worker.mjs",
      "zsr-orbstack-container-host.mjs",
    ),
    "--bridge",
    "/state/podman.sock",
    descriptor.sessionKey,
  ];
  return [
    "-u",
    "zeros-agent",
    "--",
    "/usr/bin/env",
    `USER=zeros-agent`,
    `LOGNAME=zeros-agent`,
    `HOME=${usernsState}`,
    "PATH=/usr/bin:/bin",
    PODMAN,
    "--root",
    path.join(usernsState, "storage"),
    "--runroot",
    usernsRuntime,
    "--storage-driver=vfs",
    "unshare",
    ...bwrap,
  ];
}

async function host(descriptorPath) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("OrbStack container host requires VM root");
  }
  const descriptor = readDescriptor(descriptorPath);
  const identity = spawnSync("/usr/bin/id", ["-u", "zeros-agent"], {
    encoding: "utf8",
  });
  const group = spawnSync("/usr/bin/id", ["-g", "zeros-agent"], {
    encoding: "utf8",
  });
  if (
    identity.status !== 0 ||
    group.status !== 0 ||
    Number(identity.stdout.trim()) !== descriptor.uid ||
    Number(group.stdout.trim()) !== descriptor.gid
  ) {
    fail("OrbStack worker identity does not match the Mac owner");
  }
  for (const executable of [WORKER, NODE, PODMAN, BWRAP, RUNUSER, NFT]) {
    const file = physical(executable, "file", "runtime executable");
    if ((file.stat.mode & 0o022) !== 0) fail("runtime executable is writable");
  }
  const resolvConf = physical(
    ORBSTACK_RESOLV_CONF,
    "file",
    "OrbStack DNS projection",
  );
  if (resolvConf.stat.uid !== 0 || (resolvConf.stat.mode & 0o022) !== 0) {
    fail("OrbStack DNS projection is writable or untrusted");
  }
  for (const root of [STATE_ROOT, USERNS_ROOT]) {
    mkdirSync(root, { recursive: true, mode: 0o711 });
    chmodSync(root, 0o711);
    physical(root, "directory", "worker state parent");
  }
  const sessionState = path.join(STATE_ROOT, descriptor.sessionKey);
  const workerState = path.join(sessionState, "worker");
  const usernsState = path.join(USERNS_ROOT, descriptor.sessionKey);
  for (const directory of [sessionState, workerState, usernsState]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { mode: 0o700 });
      const ownership = spawnSync("/usr/bin/chown", [
        `${descriptor.uid}:${descriptor.gid}`,
        directory,
      ]);
      if (ownership.status !== 0) fail("worker state ownership failed");
    }
    const stateDirectory = physical(
      directory,
      "directory",
      "worker state directory",
    );
    if (
      stateDirectory.stat.uid !== descriptor.uid ||
      stateDirectory.stat.gid !== descriptor.gid ||
      (stateDirectory.stat.mode & 0o077) !== 0
    ) {
      fail("worker state directory ownership is unsafe");
    }
    chmodSync(directory, 0o700);
  }
  mkdirSync(USERNS_RUNTIME_ROOT, { recursive: true, mode: 0o711 });
  chmodSync(USERNS_RUNTIME_ROOT, 0o711);
  const usernsRuntime = path.join(USERNS_RUNTIME_ROOT, descriptor.sessionKey);
  rmSync(usernsRuntime, { recursive: true, force: true });
  mkdirSync(usernsRuntime, { mode: 0o700 });
  const runtimeOwnership = spawnSync("/usr/bin/chown", [
    `${descriptor.uid}:${descriptor.gid}`,
    usernsRuntime,
  ]);
  if (runtimeOwnership.status !== 0)
    fail("user namespace runtime ownership failed");
  const metadata = path.join(sessionState, "host.json");

  const child = spawn(
    RUNUSER,
    workerArguments(descriptor, workerState, usernsState, usernsRuntime),
    {
      cwd: descriptor.workspace,
      env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  if (!Number.isInteger(child.pid) || child.pid < 2) {
    fail("private worker process identity is unavailable");
  }
  writeFileSync(
    metadata,
    `${JSON.stringify({
      version: CONTRACT_VERSION,
      generationHash: createHash("sha256")
        .update(descriptor.generation)
        .digest("hex"),
      hostPid: process.pid,
      childPgid: child.pid,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  let stdout = "";
  let diagnostic = "";
  let readyPort = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout = (stdout + chunk).slice(-16_384);
    const lines = stdout.split("\n");
    stdout = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (
          parsed.version === CONTRACT_VERSION &&
          parsed.bridgeReady === true &&
          Number.isInteger(parsed.port) &&
          parsed.port >= 1 &&
          parsed.port <= 65_535
        ) {
          readyPort = parsed.port;
          readyResolve(parsed.port);
        }
      } catch {
        // The trusted helper emits one JSON readiness line; ignore bounded
        // tool chatter without reflecting it across the Mac trust boundary.
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk).slice(-MAX_DIAGNOSTIC_BYTES);
  });
  const childExit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.once("error", () => readyReject(new Error("worker spawn failed")));
  child.once("exit", (code, signal) => {
    if (readyPort === null) {
      readyReject(
        new Error(`worker exited before readiness (${code ?? signal})`),
      );
    }
  });

  let port;
  let firewallRefresh = null;
  let processDomainProven = false;
  try {
    port = await Promise.race([
      ready,
      delay(READY_TIMEOUT_MS).then(() => {
        throw new Error("worker readiness timed out");
      }),
    ]);
    resetFirewall(port);
    firewallRefresh = setInterval(() => {
      try {
        refreshFirewall(port);
      } catch {
        void stopGroup(child.pid);
      }
    }, 3_000);
    firewallRefresh.unref();
    process.stdout.write(
      `${JSON.stringify({ version: CONTRACT_VERSION, ready: true, port })}\n`,
    );
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      process.once(signal, () => void stopGroup(child.pid));
    }
    const outcome = await childExit;
    if (outcome.code !== 0) {
      throw new Error(
        `private worker exited unexpectedly (${outcome.code ?? outcome.signal})`,
      );
    }
    await stopGroup(child.pid);
    processDomainProven = true;
  } catch (error) {
    let teardownError = null;
    try {
      await stopGroup(child.pid);
      processDomainProven = true;
    } catch (failure) {
      teardownError = failure;
    }
    if (diagnostic) {
      writeFileSync(
        path.join(sessionState, "diagnostic.log"),
        diagnostic.slice(-MAX_DIAGNOSTIC_BYTES),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    if (teardownError) {
      throw new AggregateError(
        [error, teardownError],
        "private worker failed and its process domain was preserved for recovery",
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${
        diagnostic ? "; diagnostics retained in the isolated worker" : ""
      }`,
    );
  } finally {
    if (firewallRefresh) clearInterval(firewallRefresh);
    clearFirewall();
    if (processDomainProven) {
      rmSync(metadata, { force: true });
      rmSync(usernsRuntime, { recursive: true, force: true });
    }
  }
}

async function recover(sessionKey) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("OrbStack recovery requires VM root");
  }
  if (!/^[a-f0-9]{32}$/.test(sessionKey)) fail("invalid recovery session key");
  const sessionState = path.join(STATE_ROOT, sessionKey);
  const metadata = path.join(sessionState, "host.json");
  let recovered = 0;
  if (existsSync(metadata)) {
    const file = physical(metadata, "file", "worker recovery metadata");
    if (file.stat.size > 16 * 1024 || (file.stat.mode & 0o077) !== 0) {
      fail("worker recovery metadata is unsafe");
    }
    const value = JSON.parse(readFileSync(metadata, "utf8"));
    exactKeys(
      value,
      ["childPgid", "generationHash", "hostPid", "version"],
      "worker recovery metadata",
    );
    if (
      value.version !== CONTRACT_VERSION ||
      !/^[a-f0-9]{64}$/.test(value.generationHash) ||
      !Number.isInteger(value.hostPid) ||
      value.hostPid < 2 ||
      !Number.isInteger(value.childPgid) ||
      value.childPgid < 2
    ) {
      fail("worker recovery metadata is malformed");
    }
    if (processGroupExists(value.childPgid)) {
      const commandLinePath = `/proc/${value.childPgid}/cmdline`;
      let commandLine = "";
      try {
        commandLine = readFileSync(commandLinePath, "utf8");
      } catch {
        fail("worker process identity could not be proven");
      }
      if (
        !commandLine.includes(RUNUSER) ||
        !commandLine.includes("zsr-container-worker.mjs") ||
        !commandLine.includes(sessionKey)
      ) {
        fail("worker recovery process identity does not match");
      }
      await stopGroup(value.childPgid);
      recovered = 1;
    }
    rmSync(metadata, { force: true });
  }
  clearFirewall();
  rmSync(path.join(USERNS_RUNTIME_ROOT, sessionKey), {
    recursive: true,
    force: true,
  });
  process.stdout.write(
    `${JSON.stringify({ version: CONTRACT_VERSION, recovered })}\n`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === "--bridge") {
    await bridge(args[1], args[2]);
    return;
  }
  if (args.length === 2 && args[0] === "--relay") {
    await relay(args[1]);
    return;
  }
  if (args.length === 2 && args[0] === "--descriptor") {
    await host(args[1]);
    return;
  }
  if (args.length === 2 && args[0] === "--recover") {
    await recover(args[1]);
    return;
  }
  fail("invalid OrbStack container host arguments");
}

await main().catch((error) => {
  process.stderr.write(
    `[zsr-orbstack-container-host] ${
      error instanceof Error ? error.message : "worker failed"
    }\n`,
  );
  process.exitCode = 125;
});
