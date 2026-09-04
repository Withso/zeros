import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import tls from "node:tls";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CA_TRUST_ENV_NAMES,
  ZsrExecutionBoundary,
} from "../../apps/desktop/src/engine/agents/containment/zsr-boundary";
import { loadCloudWorkerConfiguration } from "../../apps/desktop/src/engine/agents/containment/cloud-worker-config";
import { HostExecutionBoundary } from "../../apps/desktop/src/engine/agents/containment/host-boundary";
import { RoutingExecutionBoundary } from "../../apps/desktop/src/engine/agents/containment/routing-boundary";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function git(args: readonly string[], cwd: string): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
}

function gitOutput(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0] ?? "command"} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function hostEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) &&
        typeof entry[1] === "string",
    ),
  );
}

async function collect(
  child: Awaited<
    ReturnType<Awaited<ReturnType<ZsrExecutionBoundary["prepare"]>>["spawn"]>
  >,
): Promise<ChildResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8_192);
  });
  const exit = await child.wait();
  return { code: exit.code, stdout, stderr };
}

async function reserveService(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const server = createServer((socket) => socket.end("host-service\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("host service omitted its TCP address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function reserveAmbientContainerSocket(): Promise<{
  path: string;
  close(): Promise<void>;
}> {
  const socketPath = path.join(
    process.platform === "darwin" ? "/private/tmp" : os.tmpdir(),
    `zeros-zq-container-${process.pid}-${randomUUID().slice(0, 8)}.sock`,
  );
  const server = createServer((socket) => {
    // The native-host probe exits as soon as connect succeeds. Its intentional
    // early close may surface as ECONNRESET on the accepting socket; that is
    // evidence of visibility, not a qualification-process failure.
    socket.on("error", () => undefined);
    socket.end("ambient-container\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  // The cloud worker uses a distinct uid. Make a failed subtraction observable
  // there too instead of letting socket ownership create a false pass.
  await chmod(socketPath, 0o777);
  return {
    path: socketPath,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(socketPath, { force: true });
    },
  };
}

function territory(
  workspace: string,
  designs: readonly string[],
): {
  agentRole: "code";
  workspaceRoot: string;
  designDirectory: string;
  protectedDesignDirectories: readonly string[];
  designRecognitionPaths: readonly string[];
  writeCapabilities: {
    workspace: "write";
    deniedPaths: string[];
  };
} {
  // Territory discovery records the full semantic set, while the host-parity
  // policy subtracts Design content and engine-owned authority only. Declaring
  // the recognition inputs here proves committed settings remain native rather
  // than disappearing from the fixture before policy construction.
  const recognition = [
    path.join(workspace, ".zeros"),
    ...designs.map((design) => path.join(design, ".zeros-canvas.json")),
  ];
  return {
    agentRole: "code",
    workspaceRoot: workspace,
    designDirectory: designs[0]!,
    protectedDesignDirectories: designs,
    designRecognitionPaths: recognition,
    writeCapabilities: {
      workspace: "write",
      deniedPaths: [...designs, ...recognition, path.join(workspace, ".git")],
    },
  };
}

async function grantWorkerTree(
  root: string,
  identity: { uid: number; gid: number },
): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await lchown(candidate, identity.uid, identity.gid);
      continue;
    }
    if (entry.isDirectory()) await grantWorkerTree(candidate, identity);
    await chown(candidate, identity.uid, identity.gid);
  }
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("cloud qualification worker root is not physical");
  }
  await chown(root, identity.uid, identity.gid);
}

async function run(): Promise<void> {
  if (!new Set(["darwin", "linux"]).has(process.platform)) {
    throw new Error("local host-parity qualification requires macOS or Linux");
  }

  const cloudConfigurationPath =
    process.env.ZEROS_ZSR_CLOUD_WORKER_CONFIG?.trim();
  const cloudConfiguration = cloudConfigurationPath
    ? loadCloudWorkerConfiguration(cloudConfigurationPath)
    : null;
  if (cloudConfigurationPath && !cloudConfiguration) {
    throw new Error("cloud host-parity qualification marker is unavailable");
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "zeros-zsr-local-parity-"));
  const workspace = path.join(root, "workspace");
  const primaryDesign = path.join(workspace, "Zeros Design");
  const secondaryDesign = path.join(workspace, "examples", "Product Design");
  const designs = [primaryDesign, secondaryDesign] as const;
  const hostHome = process.env.HOME || os.homedir();
  const hostLog = path.join(root, "host-app.log");
  const hostCaBundle = path.join(root, "host-ca-bundle.pem");
  const workerScratch = path.join(root, "worker-scratch");
  const outsideCache = path.join(workerScratch, "outside-cache.txt");
  const remote = path.join(root, "remote.git");
  const hookMarker = path.join(root, "pre-push-ran.txt");
  const codeFile = path.join(workspace, "code.txt");
  const primaryFile = path.join(primaryDesign, "canvas.json");
  const primaryMarker = path.join(primaryDesign, ".zeros-canvas.json");
  const repoSettingsFile = path.join(workspace, ".zeros", "settings.toml");
  const secondaryFile = path.join(secondaryDesign, "tokens.json");
  const designAlias = path.join(workspace, "design-alias");
  const previousDataDir = process.env.ZEROS_DATA_DIR;
  process.env.ZEROS_DATA_DIR = path.join(root, "engine");
  const engineDatabase = path.join(process.env.ZEROS_DATA_DIR, "zeros.db");
  const engineAuthorityFiles = [
    engineDatabase,
    `${engineDatabase}-wal`,
    `${engineDatabase}-shm`,
    `${engineDatabase}-journal`,
    path.join(process.env.ZEROS_DATA_DIR, "design-recognition.json"),
    path.join(
      process.env.ZEROS_DATA_DIR,
      "worktrees",
      "fixture",
      "workspace.json",
    ),
  ];
  const engineAuthorityAliasRoot = path.join(root, "engine-authority-aliases");
  const service = await reserveService();
  const ambientContainer = await reserveAmbientContainerSocket();
  let codeBoundary: Awaited<
    ReturnType<ZsrExecutionBoundary["prepare"]>
  > | null = null;
  let designBoundary: Awaited<
    ReturnType<ZsrExecutionBoundary["prepare"]>
  > | null = null;

  try {
    await Promise.all([
      mkdir(primaryDesign, { recursive: true }),
      mkdir(secondaryDesign, { recursive: true }),
      mkdir(engineAuthorityAliasRoot, { recursive: true }),
      mkdir(workerScratch, { recursive: true }),
    ]);
    await mkdir(path.dirname(repoSettingsFile), { recursive: true });
    await mkdir(path.dirname(engineAuthorityFiles.at(-1)!), {
      recursive: true,
    });
    await Promise.all([
      writeFile(hostLog, "host-log-visible\n"),
      writeFile(codeFile, "initial-code\n"),
      writeFile(primaryFile, '{"mode":"code-protected"}\n'),
      writeFile(secondaryFile, '{"mode":"code-protected"}\n'),
      writeFile(primaryMarker, "{}\n"),
      writeFile(repoSettingsFile, '[design]\ndirectory = "Zeros Design"\n'),
      ...engineAuthorityFiles.map((file) => writeFile(file, "engine-owned\n")),
      symlink(primaryDesign, designAlias, "dir"),
    ]);
    git(["init", "-b", "main"], workspace);
    git(["config", "user.name", "Zeros Qualification"], workspace);
    git(
      ["config", "user.email", "zsr-qualification@example.invalid"],
      workspace,
    );
    git(
      ["add", "--", "code.txt", "Zeros Design", "examples", ".zeros"],
      workspace,
    );
    git(["commit", "-m", "initial"], workspace);
    // A SECOND commit that changes a tracked Design file. The worktree still
    // matches HEAD — so the native-git proof below stays clean — but the FIRST
    // commit now holds different Design bytes, which makes the in-fence
    // `git checkout <initial> -- <design>` a genuine attempt to write protected
    // territory. Arranging the Design tree to already match the restore target is
    // exactly what left this case unexercised: git never touched the path at all.
    // The exact sha travels into the fence rather than a relative ref, because the
    // fenced script commits too and would shift `HEAD~1` out from under it.
    const initialCommit = gitOutput(["rev-parse", "HEAD"], workspace);
    await writeFile(primaryFile, '{"mode":"code-protected-v2"}\n');
    git(["add", "--", "Zeros Design"], workspace);
    git(["commit", "-m", "design update"], workspace);
    git(["init", "--bare", remote], root);
    git(["remote", "add", "origin", remote], workspace);
    await writeFile(
      path.join(workspace, ".git", "hooks", "pre-push"),
      `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(hookMarker)}\n`,
    );
    await chmod(path.join(workspace, ".git", "hooks", "pre-push"), 0o700);
    if (cloudConfiguration) {
      await chmod(root, 0o711);
      await Promise.all([
        grantWorkerTree(workspace, cloudConfiguration),
        grantWorkerTree(remote, cloudConfiguration),
        grantWorkerTree(workerScratch, cloudConfiguration),
        grantWorkerTree(engineAuthorityAliasRoot, cloudConfiguration),
      ]);
    }

    const sandboxBoundary = new ZsrExecutionBoundary({
      projectRoot,
      supervisorScript: path.join(projectRoot, "binaries/zsr-supervisor.mjs"),
      macosProcessDomainHelper: path.join(
        projectRoot,
        "binaries/zsr-macos-process-domain",
      ),
      ...(cloudConfiguration
        ? {
            cloudWorker: cloudConfiguration,
            cloudWorkerToolchain: cloudConfiguration.toolchain,
          }
        : {}),
    });
    const boundary = new RoutingExecutionBoundary({
      host: new HostExecutionBoundary({
        projectRoot,
        supervisorRuntime: process.execPath,
      }),
      sandbox: sandboxBoundary,
      forceSandbox: Boolean(cloudConfiguration),
    });
    // A real, readable PEM so the child's Node runtime accepts the sentinel
    // silently. The point of the variable is not the trust it adds: it is that a
    // configured host trust path must arrive in the session BYTE-IDENTICAL, and
    // that the names the host left unset must stay unset. The supervisor sits in
    // between; under host parity it must rewrite none of them.
    await writeFile(hostCaBundle, `${tls.rootCertificates[0] ?? ""}\n`);
    const sentinelEnv = {
      HOME: hostHome,
      GH_TOKEN: "zsr-qualification-gh-token",
      GITHUB_TOKEN: "zsr-qualification-github-token",
      SSH_AUTH_SOCK: path.join(root, "qualification-ssh-agent.sock"),
      NODE_EXTRA_CA_CERTS: hostCaBundle,
      GIT_SSL_CAINFO: hostCaBundle,
    };
    // Every trust name the child should see, exactly as the host set it. `null`
    // means "the host never set this, so nothing may set it either" — the shape
    // the bug took: 15 names arriving as the literal string "undefined", which
    // breaks `git clone https://…`, `curl`, and `pip install` inside an
    // otherwise host-identical session.
    const expectedCaEnv = Object.fromEntries(
      CA_TRUST_ENV_NAMES.map((name) => [
        name,
        sentinelEnv[name as keyof typeof sentinelEnv] ??
          process.env[name] ??
          null,
      ]),
    );
    const codeAdmissionStarted = performance.now();
    codeBoundary = await boundary.prepare({
      executionId: `local-code-${process.pid}`,
      actor: "agent-code",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
      ...(cloudConfiguration
        ? {
            territory: territory(workspace, designs),
            containerWorkflowExpected: true,
          }
        : {}),
    });
    const cloudContainerBoundary =
      !cloudConfiguration ||
      (codeBoundary.status.backend === "cloud-worker" &&
        codeBoundary.status.parity.level === "full" &&
        codeBoundary.status.parity.restrictions.length === 0 &&
        codeBoundary.status.services?.state === "ready" &&
        codeBoundary.status.services.kinds.includes("podman"));
    const codeAdmissionMs = Math.round(
      performance.now() - codeAdmissionStarted,
    );
    const portLease = await codeBoundary.requestPort({
      protocol: "tcp",
      preferredPort: 5173,
      purpose: "dev-server",
    });

    const codeChild = await codeBoundary.spawn({
      command: process.execPath,
      args: [
        "-e",
        String.raw`
const fs = require("node:fs");
const net = require("node:net");
const { spawnSync } = require("node:child_process");
const [hostLog, codeFile, primary, secondary, aliasFile, servicePort, expectedCa, settingsFile, markerFile, divergedDesignFile, restoreFromCommit, authorityFilesJson, authorityAliasRoot, ambientContainerSocket, macosAuthorityHelper, cloudContainerExpected] = process.argv.slice(1);
function denied(write) { try { write(); return false; } catch { return true; } }
const caExpected = JSON.parse(expectedCa);
const caDrift = Object.entries(caExpected).flatMap(([name, value]) => {
  const actual = process.env[name] === undefined ? null : process.env[name];
  return actual === value ? [] : [name + "=" + String(actual)];
});
const designDenied = [primary, secondary, aliasFile].map((file) =>
  denied(() => fs.writeFileSync(file, "forbidden\n")),
);
// Recognition, and the deliberate split in how it is protected. The canvas
// marker lives inside protected Design territory, so it stays unwritable. The
// .zeros pointer is ordinary committed repository content and MUST stay
// writable, or every git pull that touches team settings fails on it —
// de-registration is covered by engine-side sticky recognition instead.
// (No backticks in this comment: it lives inside a String.raw template.)
const markerDenied = denied(() => fs.writeFileSync(markerFile, "de-registered\n"));
const repoSettingsWritable = !denied(() =>
  fs.appendFileSync(settingsFile, "\n# host-parity settings write\n"),
);
const authorityFiles = JSON.parse(authorityFilesJson);
const engineAuthorityRead = authorityFiles.every((file) => {
  try { return fs.readFileSync(file, "utf8") === "engine-owned\n"; }
  catch { return false; }
});
const engineAuthorityWriteDenied = authorityFiles.map((file) =>
  denied(() => fs.writeFileSync(file, "forbidden\n")),
);
const engineAuthorityHardlinkDenied = authorityFiles.map((file, index) =>
  denied(() => fs.linkSync(file, require("node:path").join(authorityAliasRoot, String(index)))),
);
fs.writeFileSync(codeFile, "host-parity-code\n");
const commands = [
  ["-c", "core.abbrev=12", "status", "--porcelain"],
  ["add", "--", "code.txt"],
  ["commit", "-m", "host parity"],
  ["reset", "--hard", "HEAD"],
  ["push", "-u", "origin", "main"],
];
const git = commands.map((args) => spawnSync("git", args, { encoding: "utf8" }));
// LAST, and path-scoped: make git ITSELF attempt a Design write. HEAD~1 holds
// different Design bytes (the engine committed a second revision before
// admission), so this is a real write into protected territory — not a no-op the
// kernel never sees. Runs after the commands above so their all-zero exit codes
// still prove ordinary native git works.
const designRestore = spawnSync(
  "git",
  ["checkout", restoreFromCommit, "--", "Zeros Design/canvas.json"],
  { encoding: "utf8" },
);
const gh = spawnSync("gh", ["--version"], { encoding: "utf8" });
const keychain = process.platform === "darwin"
  ? spawnSync("security", ["list-keychains"], { encoding: "utf8" })
  : { status: 0 };
let appleEventsDenied = true;
if (process.platform === "darwin") {
  const authority = spawnSync(macosAuthorityHelper, ["authority"], {
    encoding: "utf8",
  });
  try {
    const report = JSON.parse(authority.stdout);
    appleEventsDenied =
      authority.status === 0 && report.appleEventsDenied === true;
  } catch {
    appleEventsDenied = false;
  }
}
const ambientContainerProbe = spawnSync(
  process.execPath,
  [
    "-e",
    'const net=require("node:net");const socket=net.connect(process.argv[1]);socket.once("connect",()=>process.exit(91));socket.once("error",()=>process.exit(0));setTimeout(()=>process.exit(92),1500).unref();',
    ambientContainerSocket,
  ],
  { encoding: "utf8", timeout: 3_000 },
);
const ambientContainerSocketDenied = ambientContainerProbe.status === 0;
const ambientContainerSocketVisible = ambientContainerProbe.status === 91;
const expectsPrivateContainer = cloudContainerExpected === "true";
const privateContainerEndpoint = process.env.DOCKER_HOST;
const ambientContainerSelectorsScrubbed = expectsPrivateContainer
  ? privateContainerEndpoint === process.env.CONTAINER_HOST &&
    privateContainerEndpoint?.startsWith("unix://") === true &&
    privateContainerEndpoint.endsWith("/container-worker/podman.sock") &&
    ["DOCKER_CONTEXT", "CONTAINER_CONNECTION", "PODMAN_HOST"].every(
      (name) => process.env[name] === undefined,
    )
  : [
      "DOCKER_HOST",
      "DOCKER_CONTEXT",
      "CONTAINER_HOST",
      "CONTAINER_CONNECTION",
      "PODMAN_HOST",
    ].every((name) => process.env[name] === undefined);
const ambientContainerSelectorsPreserved =
  process.env.DOCKER_HOST === "unix://" + ambientContainerSocket &&
  process.env.DOCKER_CONTEXT === "ambient-qualification" &&
  process.env.CONTAINER_HOST === "unix://" + ambientContainerSocket &&
  process.env.CONTAINER_CONNECTION === "ambient-qualification" &&
  process.env.PODMAN_HOST === "unix://" + ambientContainerSocket;
const privateContainerProbe = expectsPrivateContainer
  ? spawnSync("podman", ["info", "--format=json"], {
      encoding: "utf8",
      timeout: 15_000,
    })
  : { status: 0 };
const privateContainerReady =
  !expectsPrivateContainer || privateContainerProbe.status === 0;
const connection = net.connect({ host: "127.0.0.1", port: Number(servicePort) });
let service = "";
connection.setEncoding("utf8");
connection.on("data", (chunk) => { service += chunk; });
connection.once("end", () => {
  const server = net.createServer((socket) => socket.end("agent-port\n"));
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const self = net.connect({ host: "127.0.0.1", port });
    let selfReply = "";
    self.setEncoding("utf8");
    self.on("data", (chunk) => { selfReply += chunk; });
    self.once("end", () => {
      server.close(() => {
        process.stdout.write(JSON.stringify({
          hostRead: fs.readFileSync(hostLog, "utf8") === "host-log-visible\n",
          codeWrite: fs.readFileSync(codeFile, "utf8") === "host-parity-code\n",
          designDenied,
          markerDenied,
          repoSettingsWritable,
          engineAuthorityRead,
          engineAuthorityWriteDenied,
          engineAuthorityHardlinkDenied,
          designRestoreRefused: designRestore.status !== 0,
          designRestoreBytes: fs.readFileSync(divergedDesignFile, "utf8"),
          gitStatuses: git.map((entry) => entry.status),
          rawGitErrors: git.map((entry) => entry.stderr || "").join(""),
          canonicalGit: !process.env.GIT_DIR,
          home: process.env.HOME,
          ghToken: process.env.GH_TOKEN,
          githubToken: process.env.GITHUB_TOKEN,
          sshSocket: process.env.SSH_AUTH_SOCK,
          ghAvailable: gh.status === 0,
          keychainAvailable: keychain.status === 0,
          appleEventsDenied,
          ambientContainerSocketDenied,
          ambientContainerSocketVisible,
          ambientContainerSelectorsScrubbed,
          ambientContainerSelectorsPreserved,
          privateContainerReady,
          directService: service === "host-service\n",
          directPort: selfReply === "agent-port\n",
          proxyUnchanged: process.env.HTTP_PROXY === ${JSON.stringify(process.env.HTTP_PROXY)},
          noNetworkBridge: !process.env.ZEROS_ZSR_NETWORK_BRIDGE,
          caTrustExact: caDrift.length === 0,
          caTrustDrift: caDrift,
          workerIdentity: process.getuid?.() ?? null,
        }) + "\n");
      });
    });
  });
});
connection.once("error", (error) => { throw error; });
`,
        hostLog,
        codeFile,
        primaryFile,
        secondaryFile,
        path.join(designAlias, "canvas.json"),
        String(service.port),
        JSON.stringify(expectedCaEnv),
        repoSettingsFile,
        primaryMarker,
        primaryFile,
        initialCommit,
        JSON.stringify(engineAuthorityFiles),
        engineAuthorityAliasRoot,
        ambientContainer.path,
        path.join(projectRoot, "binaries", "zsr-macos-process-domain"),
        String(Boolean(cloudConfiguration)),
      ],
      cwd: workspace,
      env: {
        ...hostEnvironment(),
        ...sentinelEnv,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DOCKER_HOST: `unix://${ambientContainer.path}`,
        DOCKER_CONTEXT: "ambient-qualification",
        CONTAINER_HOST: `unix://${ambientContainer.path}`,
        CONTAINER_CONNECTION: "ambient-qualification",
        PODMAN_HOST: `unix://${ambientContainer.path}`,
      },
      stdio: "pipe",
    });
    const codeResult = await collect(codeChild);
    if (codeResult.code !== 0) {
      throw new Error(`code fixture failed: ${codeResult.stderr}`);
    }
    const codeReport = JSON.parse(codeResult.stdout.trim()) as Record<
      string,
      unknown
    >;
    const codeBackend = codeBoundary.status.backend;
    await codeBoundary.stopAndProve();
    codeBoundary = null;

    // Native Code is intentionally unrestricted and the fixture proves that
    // honestly by attempting writes to the temporary engine authority files.
    // Restore their sentinel bytes before admitting Design so the ZSR read deny
    // cannot pass merely because Code changed the expected value.
    await Promise.all(
      engineAuthorityFiles.map((file) => writeFile(file, "engine-owned\n")),
    );
    await rm(engineAuthorityAliasRoot, { recursive: true, force: true });
    await mkdir(engineAuthorityAliasRoot, { recursive: true });

    const designAdmissionStarted = performance.now();
    designBoundary = await boundary.prepare({
      executionId: `local-design-${process.pid}`,
      actor: "design-agent",
      providerId: "codex",
      providerStateEnv: { HOME: hostHome },
      cwd: workspace,
      workspaceRoot: workspace,
      territory: territory(workspace, designs),
    });
    const designAdmissionMs = Math.round(
      performance.now() - designAdmissionStarted,
    );
    const designChild = await designBoundary.spawn({
      command: process.execPath,
      args: [
        "-e",
        String.raw`
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const [codeFile, primary, secondary, outside, authorityFilesJson, authorityAliasRoot] = process.argv.slice(1);
const authorityFiles = JSON.parse(authorityFilesJson);
function denied(operation) { try { operation(); return false; } catch { return true; } }
const engineAuthorityReadDenied = authorityFiles.map((file) =>
  denied(() => fs.readFileSync(file, "utf8")),
);
const engineAuthorityWriteDenied = authorityFiles.map((file) => {
  return denied(() => fs.writeFileSync(file, "forbidden\n"));
});
const engineAuthorityHardlinkDenied = authorityFiles.map((file, index) => {
  return denied(() => fs.linkSync(file, require("node:path").join(authorityAliasRoot, "design-" + index)));
});
const codeReadable = fs.readFileSync(codeFile, "utf8") === "host-parity-code\n";
const designReadable = [primary, secondary].every((file) => fs.readFileSync(file, "utf8").length > 0);
const codeDenied = denied(() => fs.writeFileSync(codeFile, "forbidden-design-code\n"));
const primaryDenied = denied(() => fs.writeFileSync(primary, '{"mode":"forbidden-design-write"}\n'));
const secondaryDenied = denied(() => fs.writeFileSync(secondary, '{"mode":"forbidden-design-write"}\n'));
const outsideDenied = denied(() => fs.writeFileSync(outside, "outside-write\n"));
const gitDirectoryWriteDenied = denied(() => {
  fs.writeFileSync(".git/qualification-write", "ok\n");
  fs.unlinkSync(".git/qualification-write");
});
const scratchFile = require("node:path").join(process.env.TMPDIR, "design-scratch.txt");
fs.writeFileSync(scratchFile, "scratch-write\n");
const providerRoots = [
  process.env.XDG_CACHE_HOME,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_STATE_HOME,
];
const providerStateWrites = providerRoots.map((root, index) => {
  fs.mkdirSync(root, { recursive: true });
  const file = require("node:path").join(root, "qualification-" + index + ".txt");
  fs.writeFileSync(file, "provider-write\n");
  return fs.readFileSync(file, "utf8") === "provider-write\n";
});
const git = spawnSync("git", ["add", "--", "Zeros Design/canvas.json", "examples/Product Design/tokens.json"], { encoding: "utf8" });
process.stdout.write(JSON.stringify({
  codeReadable,
  designReadable,
  codeDenied,
  primaryDenied,
  secondaryDenied,
  outsideDenied,
  gitDirectoryWriteDenied,
  canonicalGitWriteDenied: git.status !== 0,
  scratchWrite: fs.readFileSync(scratchFile, "utf8") === "scratch-write\n",
  providerStateWrites,
  engineAuthorityReadDenied,
  engineAuthorityWriteDenied,
  engineAuthorityHardlinkDenied,
  gitError: git.stderr,
  home: process.env.HOME,
  ghToken: process.env.GH_TOKEN,
  workerIdentity: process.getuid?.() ?? null,
}));
`,
        codeFile,
        primaryFile,
        secondaryFile,
        outsideCache,
        JSON.stringify(engineAuthorityFiles),
        engineAuthorityAliasRoot,
      ],
      cwd: workspace,
      env: {
        ...hostEnvironment(),
        ...sentinelEnv,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
      },
      stdio: "pipe",
    });
    const designResult = await collect(designChild);
    if (designResult.code !== 0) {
      throw new Error(`design fixture failed: ${designResult.stderr}`);
    }
    const designReport = JSON.parse(designResult.stdout.trim()) as Record<
      string,
      unknown
    >;
    const designEngineAuthorityPreserved = (
      await Promise.all(
        engineAuthorityFiles.map((file) => readFile(file, "utf8")),
      )
    ).every((contents) => contents === "engine-owned\n");
    const designBackend = designBoundary.status.backend;
    await designBoundary.stopAndProve();
    designBoundary = null;

    process.stdout.write(
      `${JSON.stringify({
        code: codeReport,
        design: designReport,
        codeBackend,
        designBackend,
        designEngineAuthorityPreserved,
        hostHomePreserved: codeReport.home === hostHome,
        providerHomePreserved: hostHome === codeReport.home,
        ghTokenPreserved:
          codeReport.ghToken === sentinelEnv.GH_TOKEN &&
          designReport.ghToken === sentinelEnv.GH_TOKEN,
        githubTokenPreserved:
          codeReport.githubToken === sentinelEnv.GITHUB_TOKEN,
        sshAgentPreserved: codeReport.sshSocket === sentinelEnv.SSH_AUTH_SOCK,
        directRequestedPort:
          portLease.port === 5173 && portLease.targetPort === 5173,
        prePushHook:
          (await readFile(hookMarker, "utf8").catch(() => null)) === "ran\n",
        codeFileUnchangedByDesign:
          (await readFile(codeFile, "utf8")) === "host-parity-code\n",
        codeAdmissionMs,
        designAdmissionMs,
        cloudWorkerUid: cloudConfiguration?.uid ?? null,
        cloudContainerBoundary,
      })}\n`,
    );
  } finally {
    await Promise.allSettled([
      codeBoundary?.stopAndProve(),
      designBoundary?.stopAndProve(),
    ]);
    await service.close().catch(() => undefined);
    await ambientContainer.close().catch(() => undefined);
    if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
    else process.env.ZEROS_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
}

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
