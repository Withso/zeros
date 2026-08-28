import {
  type ChildProcess,
  type SpawnOptions,
  execFile,
  spawn,
} from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CloudWorkspaceTunnelHandle } from "./cloud-workspace-access-broker";

const SSH_CREDENTIAL_PATTERN = /^[A-Za-z0-9._~-]{16,4096}$/;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;
const DEFAULT_SSH_HOSTS = ["ssh.app.daytona.io"] as const;
const MAX_SSH_STDERR_BYTES = 64 * 1024;
const TUNNEL_CHECK_TIMEOUT_MS = 10_000;
const NATIVE_LAUNCH_ACCEPTANCE_TIMEOUT_MS = 3_000;
const SSH_HOST_KEY_TYPE_PATTERN = /^[A-Za-z0-9@._+-]{1,128}$/;
const SSH_HOST_KEY_BLOB_PATTERN = /^[A-Za-z0-9+/]{16,21844}={0,2}$/;

type SshInput = {
  sshUsername: string;
  sshHost: string;
  expiresAt: string;
};

type TunnelInput = SshInput & {
  localHost: "127.0.0.1";
  localPort: number;
  remoteHost: "127.0.0.1";
  remotePort: number;
};

export type SpawnCloudProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

type TunnelCheckInput = {
  sshBinary: string;
  configPath: string;
  controlPath: string;
  alias: string;
  child: ChildProcess;
};

type PreparedSsh = {
  directory: string;
  configPath: string;
  alias: "zeros-cloud";
};

function appPort(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1_024 && value <= 65_535;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function configQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parsePinnedKnownHost(
  value: string,
): { host: string; normalized: string } | null {
  if (value !== value.trim() || value.length > 24 * 1024) return null;
  const fields = value.split(/[ \t]+/);
  if (fields.length !== 3) return null;
  const [host, keyType, encoded] = fields as [string, string, string];
  if (
    host !== host.toLowerCase() ||
    !HOST_PATTERN.test(host) ||
    host.includes("..") ||
    !SSH_HOST_KEY_TYPE_PATTERN.test(keyType) ||
    !SSH_HOST_KEY_BLOB_PATTERN.test(encoded)
  ) {
    return null;
  }
  try {
    const blob = Buffer.from(encoded, "base64");
    if (
      blob.length < 8 ||
      blob.length > 16 * 1024 ||
      blob.toString("base64").replace(/=+$/u, "") !==
        encoded.replace(/=+$/u, "")
    ) {
      return null;
    }
    const algorithmLength = blob.readUInt32BE(0);
    if (
      algorithmLength < 1 ||
      algorithmLength > 128 ||
      4 + algorithmLength >= blob.length ||
      blob.subarray(4, 4 + algorithmLength).toString("ascii") !== keyType
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { host, normalized: `${host} ${keyType} ${encoded}` };
}

function waitForSpawn(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const onSpawn = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off("spawn", onSpawn);
      child.off("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

/** Native launchers normally hand off and exit quickly. Observe that exit so
 * an asynchronous `open`/IDE CLI refusal still revokes the freshly issued
 * provider grant. A launcher that deliberately remains alive is accepted after
 * a short bounded window and detached as before. */
function waitForAcceptedNativeLaunch(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let spawned = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      child.off("spawn", onSpawn);
      child.off("error", onError);
      child.off("close", onClose);
    };
    const accept = () => {
      cleanup();
      resolve();
    };
    const onSpawn = () => {
      spawned = true;
      timer = setTimeout(accept, NATIVE_LAUNCH_ACCEPTANCE_TIMEOUT_MS);
      timer.unref?.();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (spawned && code === 0 && signal === null) {
        resolve();
      } else {
        reject(new Error("Cloud workspace native launch failed"));
      }
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

function waitForClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    timer.unref?.();
    const onClose = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", onClose);
    };
    child.once("close", onClose);
  });
}

function commandSucceeded(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_SSH_STDERR_BYTES,
        windowsHide: true,
      },
      (error) => resolve(!error),
    );
  });
}

async function defaultCheckTunnel(input: TunnelCheckInput): Promise<boolean> {
  const deadline = Date.now() + TUNNEL_CHECK_TIMEOUT_MS;
  while (
    input.child.exitCode === null &&
    input.child.signalCode === null &&
    Date.now() < deadline
  ) {
    if (
      await commandSucceeded(
        input.sshBinary,
        [
          "-F",
          input.configPath,
          "-S",
          input.controlPath,
          "-O",
          "check",
          input.alias,
        ],
        1_000,
      )
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function defaultResolveIdeBinary(
  appId: "cursor" | "vscode",
): Promise<string | null> {
  const homeApplications = path.join(os.homedir(), "Applications");
  const candidates =
    appId === "cursor"
      ? [
          "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
          path.join(
            homeApplications,
            "Cursor.app/Contents/Resources/app/bin/cursor",
          ),
        ]
      : [
          "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
          path.join(
            homeApplications,
            "Visual Studio Code.app/Contents/Resources/app/bin/code",
          ),
        ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function defaultIdeExtensionsDirectory(
  appId: "cursor" | "vscode",
): string | null {
  const candidate = path.join(
    os.homedir(),
    appId === "cursor" ? ".cursor" : ".vscode",
    "extensions",
  );
  try {
    const metadata = lstatSync(candidate);
    return metadata.isDirectory() && !metadata.isSymbolicLink()
      ? candidate
      : null;
  } catch {
    return null;
  }
}

export class CloudWorkspaceSshRuntime {
  private readonly runtimeRoot: string;
  private readonly knownHostsPath: string;
  private readonly sshBinary: string;
  private readonly openBinary: string;
  private readonly spawn: SpawnCloudProcess;
  private readonly checkTunnel: (input: TunnelCheckInput) => Promise<boolean>;
  private readonly resolveIdeBinary: (
    appId: "cursor" | "vscode",
  ) => Promise<string | null>;
  private readonly allowedSshHosts: ReadonlySet<string>;
  private readonly knownHostEntries: readonly string[];
  private readonly trustOnFirstUse: boolean;
  private readonly activeDirectories = new Set<string>();
  private readonly cleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private rootsInitialized = false;
  private disposed = false;

  constructor(input: {
    runtimeRoot: string;
    knownHostsPath: string;
    sshBinary?: string;
    openBinary?: string;
    spawn?: SpawnCloudProcess;
    checkTunnel?: (input: TunnelCheckInput) => Promise<boolean>;
    resolveIdeBinary?: (appId: "cursor" | "vscode") => Promise<string | null>;
    allowedSshHosts?: readonly string[];
    knownHostEntries?: readonly string[];
    allowTrustOnFirstUse?: boolean;
  }) {
    this.runtimeRoot = path.resolve(input.runtimeRoot);
    this.knownHostsPath = path.resolve(input.knownHostsPath);
    this.sshBinary = input.sshBinary ?? "/usr/bin/ssh";
    this.openBinary = input.openBinary ?? "/usr/bin/open";
    this.spawn = input.spawn ?? spawn;
    this.checkTunnel = input.checkTunnel ?? defaultCheckTunnel;
    this.resolveIdeBinary = input.resolveIdeBinary ?? defaultResolveIdeBinary;
    const hosts = input.allowedSshHosts ?? DEFAULT_SSH_HOSTS;
    if (
      hosts.length < 1 ||
      hosts.some(
        (host) =>
          host !== host.toLowerCase() ||
          !HOST_PATTERN.test(host) ||
          host.includes(".."),
      )
    ) {
      throw new Error("Cloud workspace SSH host allowlist is invalid");
    }
    this.allowedSshHosts = new Set(hosts);
    const parsedEntries = (input.knownHostEntries ?? []).map(
      parsePinnedKnownHost,
    );
    const pinnedHosts = new Set(
      parsedEntries.flatMap((entry) => (entry ? [entry.host] : [])),
    );
    this.trustOnFirstUse = input.allowTrustOnFirstUse === true;
    if (
      parsedEntries.some((entry) => entry === null) ||
      parsedEntries.length !==
        new Set(parsedEntries.map((entry) => entry?.normalized)).size ||
      [...pinnedHosts].some((host) => !this.allowedSshHosts.has(host)) ||
      (parsedEntries.length > 0 &&
        [...this.allowedSshHosts].some((host) => !pinnedHosts.has(host))) ||
      (parsedEntries.length > 0 && this.trustOnFirstUse) ||
      (parsedEntries.length === 0 && !this.trustOnFirstUse)
    ) {
      throw new Error("Cloud workspace SSH host-key policy is invalid");
    }
    this.knownHostEntries = parsedEntries.map((entry) => entry!.normalized);
  }

  private validate(input: SshInput): void {
    const expiry = Date.parse(input.expiresAt);
    if (
      !SSH_CREDENTIAL_PATTERN.test(input.sshUsername) ||
      input.sshHost !== input.sshHost.toLowerCase() ||
      !this.allowedSshHosts.has(input.sshHost) ||
      !Number.isFinite(expiry) ||
      expiry <= Date.now() ||
      expiry > Date.now() + 62 * 60_000
    ) {
      throw new Error("Cloud workspace SSH access is invalid or expired");
    }
  }

  private ensurePrivateRoots(): void {
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
    const runtimeStat = lstatSync(this.runtimeRoot);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
      throw new Error("Cloud workspace SSH runtime directory is unsafe");
    }
    chmodSync(this.runtimeRoot, 0o700);
    mkdirSync(path.dirname(this.knownHostsPath), {
      recursive: true,
      mode: 0o700,
    });
    const descriptor = openSync(
      this.knownHostsPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error("Cloud workspace known-hosts file is unsafe");
      }
      fchmodSync(descriptor, 0o600);
      if (this.knownHostEntries.length > 0 && !this.rootsInitialized) {
        ftruncateSync(descriptor, 0);
        writeFileSync(descriptor, `${this.knownHostEntries.join("\n")}\n`, {
          encoding: "utf8",
        });
        fsyncSync(descriptor);
      }
    } finally {
      closeSync(descriptor);
    }
    if (!this.rootsInitialized) {
      // A crash can bypass wrapper/timer cleanup. These exact mkdtemp names
      // contain only already-expired one-shot material from a prior broker
      // lifetime; never sweep arbitrary entries from the application root.
      for (const entry of readdirSync(this.runtimeRoot)) {
        if (!/^access-[A-Za-z0-9]{6}$/.test(entry)) continue;
        rmSync(path.join(this.runtimeRoot, entry), {
          recursive: true,
          force: true,
        });
      }
      this.rootsInitialized = true;
    }
  }

  private prepare(input: SshInput): PreparedSsh {
    if (this.disposed) {
      throw new Error("Cloud workspace SSH authority has ended");
    }
    this.validate(input);
    this.ensurePrivateRoots();
    const directory = mkdtempSync(path.join(this.runtimeRoot, "access-"));
    this.activeDirectories.add(directory);
    chmodSync(directory, 0o700);
    const configPath = path.join(directory, "config");
    try {
      writeFileSync(
        configPath,
        [
          "Host zeros-cloud",
          `  HostName ${input.sshHost}`,
          `  User ${input.sshUsername}`,
          "  BatchMode yes",
          "  PasswordAuthentication no",
          "  KbdInteractiveAuthentication no",
          "  PubkeyAuthentication no",
          "  ForwardAgent no",
          "  ForwardX11 no",
          "  PermitLocalCommand no",
          `  StrictHostKeyChecking ${this.trustOnFirstUse ? "accept-new" : "yes"}`,
          `  UserKnownHostsFile ${configQuote(this.knownHostsPath)}`,
          "  LogLevel ERROR",
          "",
        ].join("\n"),
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      chmodSync(configPath, 0o600);
    } catch (error) {
      this.activeDirectories.delete(directory);
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    return { directory, configPath, alias: "zeros-cloud" };
  }

  private async removePreparedDirectory(directory: string): Promise<void> {
    const timer = this.cleanupTimers.get(directory);
    if (timer) clearTimeout(timer);
    this.cleanupTimers.delete(directory);
    this.activeDirectories.delete(directory);
    await rm(directory, { recursive: true, force: true });
  }

  private cleanupAtExpiry(directory: string, expiresAt: string): void {
    const delay = Math.max(1_000, Date.parse(expiresAt) - Date.now() + 60_000);
    const timer = setTimeout(
      () => {
        this.cleanupTimers.delete(directory);
        this.activeDirectories.delete(directory);
        void rm(directory, { recursive: true, force: true });
      },
      Math.min(delay, 2_147_000_000),
    );
    timer.unref?.();
    this.cleanupTimers.set(directory, timer);
  }

  /** Remove every projected credential when the owning auth/app lifetime ends.
   * Provider revocation is a separate broker operation and must not be relied
   * on to erase local bearer material. */
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.activeDirectories].map((directory) =>
        this.removePreparedDirectory(directory),
      ),
    );
  }

  async launchTerminal(input: SshInput): Promise<void> {
    const prepared = this.prepare(input);
    const wrapperPath = path.join(prepared.directory, "open-cloud.command");
    try {
      writeFileSync(
        wrapperPath,
        [
          "#!/bin/sh",
          `cleanup() { /bin/rm -rf -- ${shellQuote(prepared.directory)}; }`,
          "trap cleanup EXIT HUP INT TERM",
          `${shellQuote(this.sshBinary)} -F ${shellQuote(prepared.configPath)} ${prepared.alias}`,
          "status=$?",
          'exit "$status"',
          "",
        ].join("\n"),
        { encoding: "utf8", flag: "wx", mode: 0o700 },
      );
      chmodSync(wrapperPath, 0o700);
      const child = this.spawn(
        this.openBinary,
        ["-a", "Terminal", wrapperPath],
        {
          stdio: "ignore",
          detached: true,
          shell: false,
        },
      );
      await waitForAcceptedNativeLaunch(child);
      child.unref();
      this.cleanupAtExpiry(prepared.directory, input.expiresAt);
    } catch (error) {
      await this.removePreparedDirectory(prepared.directory);
      throw error;
    }
  }

  async launchIde(
    input: SshInput & { appId: "cursor" | "vscode" },
  ): Promise<void> {
    this.validate(input);
    const binary = await this.resolveIdeBinary(input.appId);
    if (!binary || !path.isAbsolute(binary) || !existsSync(binary)) {
      // An injected test resolver may point at a synthetic path; production
      // resolution only returns an existing fixed application-bundle binary.
      if (this.resolveIdeBinary === defaultResolveIdeBinary) {
        throw new Error(
          `${input.appId === "cursor" ? "Cursor" : "VS Code"} is not installed`,
        );
      }
    }
    if (!binary || !path.isAbsolute(binary)) {
      throw new Error("Remote IDE launch target is invalid");
    }
    const prepared = this.prepare(input);
    try {
      const userDataDirectory = path.join(prepared.directory, "ide-user-data");
      const userSettingsDirectory = path.join(userDataDirectory, "User");
      mkdirSync(userSettingsDirectory, { recursive: true, mode: 0o700 });
      chmodSync(userDataDirectory, 0o700);
      chmodSync(userSettingsDirectory, 0o700);
      writeFileSync(
        path.join(userSettingsDirectory, "settings.json"),
        `${JSON.stringify(
          {
            "remote.SSH.configFile": prepared.configPath,
            "remote.SSH.path": this.sshBinary,
            "remote.SSH.remotePlatform": { [prepared.alias]: "linux" },
            "remote.SSH.enableDynamicForwarding": true,
            "remote.SSH.useLocalServer": true,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      const extensionsDirectory = defaultIdeExtensionsDirectory(input.appId);
      const child = this.spawn(
        binary,
        [
          "--new-window",
          "--skip-add-to-recently-opened",
          "--user-data-dir",
          userDataDirectory,
          ...(extensionsDirectory
            ? ["--extensions-dir", extensionsDirectory]
            : []),
          "--remote",
          `ssh-remote+${prepared.alias}`,
          "/workspace/zeros",
        ],
        { stdio: "ignore", detached: true, shell: false },
      );
      await waitForAcceptedNativeLaunch(child);
      child.unref();
      this.cleanupAtExpiry(prepared.directory, input.expiresAt);
    } catch (error) {
      await this.removePreparedDirectory(prepared.directory);
      throw error;
    }
  }

  async startTunnel(input: TunnelInput): Promise<CloudWorkspaceTunnelHandle> {
    if (
      input.localHost !== "127.0.0.1" ||
      input.remoteHost !== "127.0.0.1" ||
      !appPort(input.localPort) ||
      !appPort(input.remotePort)
    ) {
      throw new Error("Cloud workspace tunnel input is invalid");
    }
    const prepared = this.prepare(input);
    const controlPath = path.join(prepared.directory, "control");
    let child: ChildProcess | null = null;
    let stderrBytes = 0;
    try {
      child = this.spawn(
        this.sshBinary,
        [
          "-F",
          prepared.configPath,
          "-M",
          "-S",
          controlPath,
          "-N",
          "-o",
          "ExitOnForwardFailure=yes",
          "-o",
          "ServerAliveInterval=15",
          "-o",
          "ServerAliveCountMax=3",
          "-L",
          `${input.localHost}:${input.localPort}:${input.remoteHost}:${input.remotePort}`,
          prepared.alias,
        ],
        {
          stdio: ["ignore", "ignore", "pipe"],
          detached: false,
          shell: false,
        },
      );
      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_SSH_STDERR_BYTES) child?.kill("SIGTERM");
      });
      await waitForSpawn(child);
      const ready = await this.checkTunnel({
        sshBinary: this.sshBinary,
        configPath: prepared.configPath,
        controlPath,
        alias: prepared.alias,
        child,
      });
      if (
        !ready ||
        child.exitCode !== null ||
        child.signalCode !== null ||
        stderrBytes > MAX_SSH_STDERR_BYTES
      ) {
        throw new Error("Cloud workspace SSH tunnel did not become ready");
      }
    } catch (error) {
      if (child) {
        child.kill("SIGTERM");
        await waitForClose(child, 1_000);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
      }
      await this.removePreparedDirectory(prepared.directory);
      throw error;
    }

    const tunnelChild = child;

    let stopPromise: Promise<void> | null = null;
    const stop = (): Promise<void> => {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        if (tunnelChild.exitCode === null && tunnelChild.signalCode === null) {
          tunnelChild.kill("SIGTERM");
          await waitForClose(tunnelChild, 3_000);
        }
        if (tunnelChild.exitCode === null && tunnelChild.signalCode === null) {
          tunnelChild.kill("SIGKILL");
          await waitForClose(tunnelChild, 1_000);
        }
        await this.removePreparedDirectory(prepared.directory);
      })();
      return stopPromise;
    };
    tunnelChild.once("close", () => {
      void this.removePreparedDirectory(prepared.directory);
    });
    const expiryTimer = setTimeout(
      () => void stop(),
      Math.max(1_000, Date.parse(input.expiresAt) - Date.now()),
    );
    expiryTimer.unref?.();
    return {
      localPort: input.localPort,
      stop: async () => {
        clearTimeout(expiryTimer);
        await stop();
      },
    };
  }
}
