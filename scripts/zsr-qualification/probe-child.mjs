#!/usr/bin/env node

import {
  appendFileSync,
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(process.argv[2] ?? "");
const servicePort = Number.parseInt(process.argv[3] ?? "0", 10);
const reversePort = Number.parseInt(process.argv[4] ?? "0", 10);
const allowedUnixSocket = process.argv[5] ?? "";
const ambientUnixSocket = process.argv[6] ?? "";
const resultFile = process.argv[7] ?? "";
const expectedUid = Number.parseInt(process.argv[8] ?? "-1", 10);
const expectedGid = Number.parseInt(process.argv[9] ?? "-1", 10);
const enginePid = Number.parseInt(process.argv[10] ?? "-1", 10);
const expectedProcessLimit = Number.parseInt(process.argv[11] ?? "-1", 10);
const expectedOpenFileLimit = Number.parseInt(process.argv[12] ?? "-1", 10);
const openCodeFixture = path.resolve(process.argv[13] ?? "");
const expectedCgroupPath = process.argv[14] ?? "";
const expectedMemoryLimit = Number.parseInt(process.argv[15] ?? "-1", 10);
const expectedCpuQuota = Number.parseInt(process.argv[16] ?? "-1", 10);
const expectedCpuPeriod = Number.parseInt(process.argv[17] ?? "-1", 10);
const containerEngine = process.argv[18] ?? "";
const containerRootfsArchive = process.argv[19] ?? "";
const containerPublishedPort = Number.parseInt(process.argv[20] ?? "-1", 10);
const nativeAttackHelper = process.argv[21] ?? "";

if (!path.isAbsolute(root) || !Number.isSafeInteger(servicePort)) {
  throw new Error("probe-child requires absolute fixture paths and ports");
}

const design = path.join(root, "Zeros Design");
const prospective = path.join(root, "Future Design");
const code = path.join(root, "code");
const result = {};

function attempt(name, operation) {
  try {
    const value = operation();
    result[name] = { ok: true, ...(value === undefined ? {} : { value }) };
  } catch (error) {
    result[name] = {
      ok: false,
      error:
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : String(error),
    };
  }
}

function requestTcp(port, payload = "ping") {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
      socket.end();
    });
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
}

function containerCommand(args, timeout = 60_000) {
  if (!path.isAbsolute(containerEngine)) {
    throw new Error("container engine was not supplied");
  }
  const socket = process.env.CONTAINER_HOST;
  if (!socket?.startsWith("unix://")) {
    throw new Error("private container endpoint was not supplied");
  }
  const child = spawnSync(
    containerEngine,
    ["--remote", "--url", socket, ...args],
    {
      cwd: code,
      env: process.env,
      encoding: "utf8",
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `container command failed (${child.status ?? child.signal}): ${child.stderr.slice(-1_000)}`,
    );
  }
  return child.stdout.trim();
}

function nativeAttack(args) {
  if (!path.isAbsolute(nativeAttackHelper)) {
    throw new Error("native attack helper was not supplied");
  }
  const child = spawnSync(nativeAttackHelper, args, {
    cwd: code,
    env: process.env,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.status !== 0) {
    throw new Error(`native attack was denied (${child.status ?? child.signal})`);
  }
  return "mutation-succeeded";
}

function requestUnix(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write("unix"));
    socket.on("data", (chunk) => {
      response += chunk;
      socket.end();
    });
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
  });
}

async function canBindTcp(port) {
  const server = createServer();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    await new Promise((resolve) => server.close(() => resolve())).catch(
      () => undefined,
    );
  }
}

attempt("designRead", () =>
  readFileSync(path.join(design, "tracked.txt"), "utf8"),
);
attempt("codeWrite", () =>
  writeFileSync(path.join(code, "created.txt"), "code\n"),
);
attempt("codeRename", () =>
  renameSync(
    path.join(code, "rename-source.txt"),
    path.join(code, "renamed.txt"),
  ),
);
attempt("codeDelete", () => rmSync(path.join(code, "delete.txt")));
attempt("projectMcpWrite", () =>
  writeFileSync(path.join(root, ".mcp.json"), '{"qualified":true}\n'),
);
attempt("projectVscodeWrite", () =>
  writeFileSync(
    path.join(root, ".vscode", "settings.json"),
    '{"qualified":true}\n',
  ),
);
attempt("projectClaudeCommandWrite", () =>
  writeFileSync(path.join(root, ".claude", "commands", "qualified.md"), "ok\n"),
);
attempt("projectGitmodulesWrite", () =>
  writeFileSync(path.join(root, ".gitmodules"), "[qualified]\n"),
);
attempt("privateControlProjection", () => {
  if (process.platform !== "linux") return "not-linux";
  const projected = path.join(root, ".git");
  if (readFileSync(path.join(projected, "identity"), "utf8") !== "private\n") {
    throw new Error("canonical control state remained visible");
  }
  writeFileSync(path.join(projected, "agent-marker"), "private-write\n", {
    flag: "wx",
    mode: 0o600,
  });
  return "private";
});

attempt("designTrackedWrite", () =>
  writeFileSync(path.join(design, "tracked.txt"), "mutated\n"),
);
attempt("designCreate", () =>
  writeFileSync(path.join(design, "created.txt"), "mutated\n"),
);
attempt("designDelete", () => rmSync(path.join(design, "delete.txt")));
attempt("designRename", () =>
  renameSync(
    path.join(design, "rename-source.txt"),
    path.join(design, "renamed.txt"),
  ),
);
attempt("designChmod", () =>
  chmodSync(path.join(design, "tracked.txt"), 0o777),
);
attempt("designAncestorRename", () =>
  renameSync(design, path.join(root, "Design moved by attacker")),
);
attempt("designSymlinkAliasWrite", () =>
  writeFileSync(
    path.join(code, "design-alias", "tracked.txt"),
    "alias mutation\n",
  ),
);
attempt("designHardlinkInto", () =>
  linkSync(
    path.join(code, "created.txt"),
    path.join(design, "hardlink-to-code"),
  ),
);
attempt("designHardlinkAlias", () => {
  const alias = path.join(code, "design-hardlink");
  linkSync(path.join(design, "tracked.txt"), alias);
  appendFileSync(alias, "hardlink mutation\n");
});
attempt("designSymlinkInto", () =>
  symlinkSync(
    path.join(code, "created.txt"),
    path.join(design, "symlink-to-code"),
  ),
);
attempt("designOpenatWrite", () => nativeAttack(["openat", design]));
attempt("designOpenatCreate", () =>
  nativeAttack(["openat-create", design]),
);
attempt("designMmapWrite", () =>
  nativeAttack(["mmap", path.join(design, "tracked.txt")]),
);
attempt("designRenameExchange", () =>
  nativeAttack([
    "rename-exchange",
    path.join(code, "created.txt"),
    path.join(design, "tracked.txt"),
  ]),
);
attempt("designDanglingAliasCreate", () => {
  const alias = path.join(code, "future-design-alias");
  if (!existsSync(alias)) symlinkSync(prospective, alias, "dir");
  mkdirSync(path.join(alias, "nested"), { recursive: true });
  writeFileSync(
    path.join(alias, "created.txt"),
    "prospective alias mutation\n",
  );
});
attempt("prospectiveDesignCreate", () => {
  mkdirSync(prospective, { recursive: true });
  writeFileSync(
    path.join(prospective, "created.txt"),
    "prospective mutation\n",
  );
});

attempt("grandchildDesignWrite", () => {
  const source =
    "require('node:fs').writeFileSync(process.argv[1], 'grandchild mutation\\n')";
  const child = spawnSync(
    process.execPath,
    ["-e", source, path.join(design, "tracked.txt")],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (child.status === 0)
    throw new Error("grandchild unexpectedly wrote Design");
  return { status: child.status, signal: child.signal };
});

attempt("opencodeWholeRuntime", () => {
  if (!path.isAbsolute(openCodeFixture)) {
    throw new Error("OpenCode fixture path is not absolute");
  }
  const child = spawnSync(
    process.execPath,
    [openCodeFixture, "runtime", root],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );
  if (child.status !== 0) {
    throw new Error(
      `OpenCode fixture failed (${child.status ?? child.signal}): ${child.stderr}`,
    );
  }
  const value = JSON.parse(child.stdout);
  const outcomes = [
    value.runtime,
    value.shell,
    value.mcp,
    value.subagent,
    value.subagent?.grandchild,
  ];
  if (
    outcomes.some(
      (outcome) =>
        !outcome?.codeWrite ||
        !outcome?.designDenied ||
        !outcome?.pluginEnvironment,
    )
  ) {
    throw new Error("OpenCode descendant authority was inconsistent");
  }
  return outcomes.map((outcome) => outcome.name);
});

attempt("containerWorker", () => {
  if (!containerEngine) return "not-configured";
  if (
    !path.isAbsolute(containerRootfsArchive) ||
    !Number.isInteger(containerPublishedPort) ||
    containerPublishedPort < 1 ||
    containerPublishedPort > 65_535
  ) {
    throw new Error("container fixture contract is invalid");
  }
  const image = `zeros-zsr-fixture-${process.pid}:latest`;
  const built = `zeros-zsr-built-${process.pid}:latest`;
  const name = `zeros-zsr-port-${process.pid}`;
  containerCommand(["import", containerRootfsArchive, image]);
  const mounted = containerCommand([
    "run",
    "--rm",
    "--volume",
    `${root}:/workspace:rw,rbind`,
    image,
    "/bin/busybox",
    "sh",
    "-c",
    "set -eu; test \"$(cat '/workspace/Zeros Design/tracked.txt')\" = before; echo container-code > /workspace/code/container-created.txt; if echo forbidden > '/workspace/Zeros Design/tracked.txt' 2>/tmp/design-error; then exit 42; fi; cat /workspace/.git/identity",
  ]);
  if (mounted !== "private") {
    throw new Error(
      "container did not receive the projected Git/workspace view",
    );
  }
  if (
    readFileSync(path.join(code, "container-created.txt"), "utf8") !==
      "container-code\n" ||
    readFileSync(path.join(design, "tracked.txt"), "utf8") !== "before\n"
  ) {
    throw new Error("container workspace authority differs from ZSR");
  }

  const context = path.join(code, "container-context");
  mkdirSync(context, { mode: 0o700 });
  writeFileSync(
    path.join(context, "Containerfile"),
    `FROM ${image}\nCOPY payload.txt /payload.txt\n`,
  );
  writeFileSync(path.join(context, "payload.txt"), "build-context\n");
  containerCommand(["build", "--tag", built, context], 90_000);
  if (
    containerCommand([
      "run",
      "--rm",
      built,
      "/bin/busybox",
      "cat",
      "/payload.txt",
    ]) !== "build-context"
  ) {
    throw new Error("remote container build lost its context");
  }

  containerCommand([
    "run",
    "--detach",
    "--name",
    name,
    "--publish",
    `127.0.0.1:${containerPublishedPort}:8080`,
    image,
    "/bin/busybox",
    "httpd",
    "-f",
    "-p",
    "8080",
    "-h",
    "/www",
  ]);
  const response = spawnSync(
    process.execPath,
    [
      "-e",
      "const http=require('node:http');const port=Number(process.argv[1]);const req=http.get({host:'127.0.0.1',port,path:'/'},res=>{let out='';res.setEncoding('utf8');res.on('data',c=>out+=c);res.on('end',()=>{if(out!=='zsr-container-port\\n')process.exit(2)})});req.setTimeout(5000,()=>req.destroy());req.on('error',()=>process.exit(3));",
      String(containerPublishedPort),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  containerCommand(["rm", "--force", name]);
  containerCommand(["rmi", "--force", built, image]);
  if (response.status !== 0) {
    throw new Error("published container port was unreachable");
  }
  return { api: "docker-compatible", build: true, volume: true, port: true };
});

attempt("ambientAuthorityAbsent", () => {
  const forbidden = Object.keys(process.env).filter((name) =>
    /^(?:ZEROS_LOCAL_WS_TOKEN|CONDUCTOR_API_TOKEN|CONDUCTOR_INTERNAL_WORKSPACE_AUTH)$/.test(
      name,
    ),
  );
  if (forbidden.length > 0)
    throw new Error(`forbidden env: ${forbidden.join(",")}`);
  return "absent";
});

attempt("hostProcessHidden", () => {
  if (process.platform !== "linux") return "not-linux";
  const status = readFileSync("/proc/self/status", "utf8");
  const namespacePids =
    /^NSpid:\s+(.+)$/m.exec(status)?.[1]?.trim().split(/\s+/) ?? [];
  if (
    namespacePids.length < 2 &&
    !(enginePid > 0 && !existsSync(`/proc/${enginePid}`))
  ) {
    throw new Error("no isolated PID namespace");
  }
  return namespacePids.length;
});

attempt("resourceLimits", () => {
  const probe = spawnSync(
    "/bin/bash",
    [
      "-c",
      `printf '%s|%s|%s' "$(ulimit -H -u)" "$(ulimit -H -n)" "$(ulimit -H -c)"`,
    ],
    { encoding: "utf8" },
  );
  const [processes, openFiles, coreBytes] = probe.stdout.split("|").map(Number);
  if (
    probe.status !== 0 ||
    !Number.isSafeInteger(processes) ||
    processes < 1 ||
    processes > expectedProcessLimit ||
    !Number.isSafeInteger(openFiles) ||
    openFiles < 1 ||
    openFiles > expectedOpenFileLimit ||
    coreBytes !== 0
  ) {
    throw new Error("descendant hard resource limits are not active");
  }
  return { processes, openFiles, coreBytes };
});

if (expectedUid > 0 && expectedGid > 0) {
  attempt("cloudWorkerIdentity", () => {
    const status = readFileSync("/proc/self/status", "utf8");
    const field = (name) =>
      new RegExp(`^${name}:\\s+(.+)$`, "m").exec(status)?.[1]?.trim() ?? "";
    const capabilityFields = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];
    if (
      process.getuid?.() !== expectedUid ||
      process.getgid?.() !== expectedGid
    ) {
      throw new Error("workload uid/gid was not dropped");
    }
    if (
      typeof process.getgroups === "function" &&
      process.getgroups().some((gid) => gid !== expectedGid)
    ) {
      throw new Error("workload retained a supplementary group");
    }
    if (capabilityFields.some((name) => !/^0+$/.test(field(name)))) {
      throw new Error("workload retained a Linux capability");
    }
    if (field("NoNewPrivs") !== "1") {
      throw new Error("workload did not lock no_new_privs");
    }
    return { uid: expectedUid, gid: expectedGid };
  });
  attempt("engineProcessHidden", () => {
    if (enginePid <= 0) throw new Error("engine pid was not supplied");
    if (existsSync(`/proc/${enginePid}`)) {
      throw new Error("trusted engine process is visible in worker /proc");
    }
    return "hidden";
  });
  attempt("cloudCgroup", () => {
    if (
      !path.isAbsolute(expectedCgroupPath) ||
      !Number.isSafeInteger(expectedMemoryLimit) ||
      !Number.isSafeInteger(expectedCpuQuota) ||
      !Number.isSafeInteger(expectedCpuPeriod)
    ) {
      throw new Error("expected cgroup contract was not supplied");
    }
    const readControl = (name) =>
      readFileSync(path.join(expectedCgroupPath, name), "utf8").trim();
    if (readControl("memory.max") !== String(expectedMemoryLimit)) {
      throw new Error("memory.max differs from the admitted contract");
    }
    if (readControl("cpu.max") !== `${expectedCpuQuota} ${expectedCpuPeriod}`) {
      throw new Error("cpu.max differs from the admitted contract");
    }
    if (readControl("pids.max") !== String(expectedProcessLimit)) {
      throw new Error("pids.max differs from the admitted contract");
    }
    if (readControl("memory.oom.group") !== "1") {
      throw new Error("the execution is not one OOM-kill domain");
    }
    if (
      existsSync(path.join(expectedCgroupPath, "memory.swap.max")) &&
      readControl("memory.swap.max") !== "0"
    ) {
      throw new Error("memory.swap.max differs from the admitted contract");
    }
    const members = new Set(
      readControl("cgroup.procs").split(/\s+/).filter(Boolean),
    );
    if (
      members.size === 0 ||
      !/^populated\s+1$/m.test(readControl("cgroup.events"))
    ) {
      throw new Error("admitted cgroup is not populated");
    }
    const cgroup = readFileSync("/proc/self/cgroup", "utf8");
    const scopeName = path.basename(expectedCgroupPath);
    if (!cgroup.includes(scopeName) && !/^0::\/$/m.test(cgroup)) {
      throw new Error(
        "cgroup namespace does not resolve to the admitted scope",
      );
    }
    return {
      scope: scopeName,
      memoryBytes: expectedMemoryLimit,
      cpu: `${expectedCpuQuota} ${expectedCpuPeriod}`,
      processes: expectedProcessLimit,
    };
  });
}

try {
  result.localService = { ok: (await requestTcp(servicePort)) === "pong" };
} catch (error) {
  result.localService = { ok: false, error: String(error) };
}

result.commonDevPortsAvailable = {
  ok:
    (await canBindTcp(1080)) &&
    (await canBindTcp(3000)) &&
    (await canBindTcp(3128)) &&
    (await canBindTcp(5173)) &&
    (await canBindTcp(8000)) &&
    (await canBindTcp(8080)),
};

if (allowedUnixSocket) {
  try {
    result.allowedUnixService = {
      ok: (await requestUnix(allowedUnixSocket)) === "allowed-unix-pong",
    };
  } catch (error) {
    result.allowedUnixService = { ok: false, error: String(error) };
  }
}

if (ambientUnixSocket) {
  try {
    result.ambientUnixService = {
      ok: (await requestUnix(ambientUnixSocket)) === "ambient-unix-pong",
    };
  } catch (error) {
    result.ambientUnixService = { ok: false, error: String(error) };
  }
}

let resolveReverseHit;
const reverseHit = new Promise((resolve) => {
  resolveReverseHit = resolve;
});
const reverse = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    socket.end(`agent:${chunk}`);
    resolveReverseHit();
  });
});
await new Promise((resolve, reject) => {
  reverse.once("error", reject);
  reverse.listen(reversePort, "127.0.0.1", resolve);
});
if (resultFile) {
  writeFileSync(resultFile, JSON.stringify({ type: "ready", result }));
}
process.stdout.write(`${JSON.stringify({ type: "ready", result })}\n`);

await new Promise((resolve) => {
  const deadline = setTimeout(resolve, 5_000);
  void reverseHit.then(() => {
    clearTimeout(deadline);
    resolve();
  });
});
await new Promise((resolve) => reverse.close(resolve));

// This is diagnostic only and contains no host path or credential.
attempt("selfExecutable", () => path.basename(readlinkSync("/proc/self/exe")));
if (resultFile) {
  writeFileSync(resultFile, JSON.stringify({ type: "done", result }));
}
process.stdout.write(`${JSON.stringify({ type: "done", result })}\n`);
