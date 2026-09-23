import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { BOAT_RESOURCE_ID_PATTERN, type BoatApiClient } from "./boat-client.js";
import { CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND } from "./daytona-setup-executor.js";
import {
  CloudProviderError,
  type CloudWorkspaceCommandRunner,
} from "./provider.js";

const SETUP_ENV = "ZEROS_CLOUD_WORKSPACE_SETUP_B64";
const HOST_KEY_COMMAND =
  "/usr/bin/sudo -n /usr/bin/cat /etc/ssh/ssh_host_ed25519_key.pub";
const ENSURE_SUPERVISOR_COMMAND =
  "/usr/bin/sudo -n /opt/zeros-runtime/bin/node /opt/zeros-runtime/lib/zeros/ensure-cloud-worker-supervisor.mjs";
const PRIVATE_ADDRESSES = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  PRIVATE_ADDRESSES.addSubnet(address, prefix, "ipv4");
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet("2000::", 3, "ipv6");
PRIVATE_ADDRESSES.addSubnet("2001:db8::", 32, "ipv6");
// Do not route SSH through protocol assignments, transition tunnels, or
// documentation space. A syntactically global 6to4 address can encode RFC1918.
// IANA special-purpose registries are the source of these conservative blocks.
PRIVATE_ADDRESSES.addSubnet("2001::", 23, "ipv6");
PRIVATE_ADDRESSES.addSubnet("2002::", 16, "ipv6");
PRIVATE_ADDRESSES.addSubnet("3fff::", 20, "ipv6");

export function isPublicBoatAddress(value: unknown): value is string {
  if (typeof value !== "string" || value.includes("%")) return false;
  const family = isIP(value);
  return family === 4
    ? !PRIVATE_ADDRESSES.check(value, "ipv4")
    : family === 6 &&
        GLOBAL_V6.check(value, "ipv6") &&
        !PRIVATE_ADDRESSES.check(value, "ipv6");
}

export function parseBoatSshEndpoint(sandbox: {
  ip?: unknown;
  sshEndpoint?: unknown;
}): { host: string; port: number } {
  // Current Boat VMs may have IPv6-only machine addresses and a separate
  // public IPv4 SSH gateway. Never infer port 22 from the machine address when
  // the authenticated provider response supplies an explicit gateway.
  if (sandbox.sshEndpoint !== undefined && sandbox.sshEndpoint !== null) {
    if (
      typeof sandbox.sshEndpoint !== "string" ||
      sandbox.sshEndpoint.length > 64
    )
      throw invalidAccess();
    const match = /^(?:\[([0-9a-fA-F:]+)\]|([0-9.]+)):([1-9][0-9]{0,4})$/.exec(
      sandbox.sshEndpoint,
    );
    const host = match?.[1] ?? match?.[2];
    const port = Number(match?.[3]);
    if (
      !isPublicBoatAddress(host) ||
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw invalidAccess();
    return { host, port };
  }
  if (!isPublicBoatAddress(sandbox.ip)) throw invalidAccess();
  return { host: sandbox.ip, port: 22 };
}

export function parseBoatHostKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096) throw invalidAccess();
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]*)?\n?$/.exec(
    value,
  );
  if (!match?.[1]) throw invalidAccess();
  const bytes = Buffer.from(match[1], "base64");
  if (
    bytes.length !== 51 ||
    bytes.toString("base64") !== match[1] ||
    bytes.readUInt32BE(0) !== 11 ||
    bytes.subarray(4, 15).toString() !== "ssh-ed25519" ||
    bytes.readUInt32BE(15) !== 32
  )
    throw invalidAccess();
  return `ssh-ed25519 ${match[1]}`;
}

function invalidAccess() {
  return new CloudProviderError(
    "provider_access_response_invalid",
    "Boat bootstrap access could not be verified",
    false,
  );
}

export type BoatBootstrapExecution = {
  resourceId: string;
  host: string;
  port: number;
  hostPublicKey: string;
  command: string;
  stdin: string;
  timeoutSeconds: number;
};
type CommandResult = Awaited<
  ReturnType<CloudWorkspaceCommandRunner["execute"]>
>;
export interface BoatBootstrapChannel {
  readonly publicKey: string;
  execute(
    input: BoatBootstrapExecution,
    signal: AbortSignal,
  ): Promise<CommandResult>;
  dispose(): Promise<void>;
}

/** Only the SSH child receives the admission on stdin. Provider keys, user
 * environment, SSH agents, user config and ambient proxy settings never do. */
async function nativeCommand(
  binary: string,
  args: readonly string[],
  input: string,
  timeoutMs: number,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<CommandResult> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args], {
      cwd: "/",
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let failed = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, signal);
        } catch {
          /* already exited */
        }
    };
    const abort = () => {
      if (failed || settled) return;
      failed = true;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 1000);
      killTimer.unref();
    };
    const deadline = setTimeout(abort, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(killTimer);
      signal.removeEventListener("abort", abort);
      if (failed || signal.aborted || code === null || code === 255) {
        reject(new Error("SSH execution outcome is unconfirmed"));
      } else
        resolve({
          exitCode: code,
          output: Buffer.concat(chunks).toString("utf8"),
          outputTruncated: false,
        });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) abort();
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes += chunk.length;
      if (errorBytes > 64 * 1024) abort();
    });
    child.stdin.on("error", abort);
    child.once("error", () => {
      failed = true;
      finish(null);
    });
    child.once("close", finish);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    child.stdin.end(input);
  });
}

export async function openBoatBootstrapChannel(
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<BoatBootstrapChannel> {
  const directory = await mkdtemp(path.join(tmpdir(), "zeros-boat-bootstrap-"));
  const privateKey = path.join(directory, "identity");
  try {
    const generated = await nativeCommand(
      "/usr/bin/ssh-keygen",
      [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "zeros-bootstrap",
        "-f",
        privateKey,
      ],
      "",
      10_000,
      4096,
      signal,
    );
    if (generated.exitCode !== 0)
      throw new Error("Bootstrap key creation failed");
    const publicKey = parseBoatHostKey(
      await readFile(`${privateKey}.pub`, "utf8"),
    );
    return {
      publicKey,
      async execute(input, signal) {
        const knownHosts = path.join(directory, "known_hosts");
        const alias = `zeros-${input.resourceId}`;
        await writeFile(
          knownHosts,
          `${alias} ${parseBoatHostKey(input.hostPublicKey)}\n`,
          { mode: 0o600, flag: "wx" },
        );
        return nativeCommand(
          "/usr/bin/ssh",
          [
            "-F",
            "/dev/null",
            "-T",
            "-p",
            String(input.port),
            "-i",
            privateKey,
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "PasswordAuthentication=no",
            "-o",
            "KbdInteractiveAuthentication=no",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            `HostKeyAlias=${alias}`,
            "-o",
            `UserKnownHostsFile=${knownHosts}`,
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "ForwardAgent=no",
            "-o",
            "ClearAllForwardings=yes",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ConnectionAttempts=1",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=2",
            `user@${input.host}`,
            input.command,
          ],
          input.stdin,
          (input.timeoutSeconds + 15) * 1000,
          maxOutputBytes,
          signal,
        );
      },
      async dispose() {
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function boatAuthorizedKeyCommand(
  publicKey: string,
  restriction?: { command: string; seconds: number },
): string {
  const key = parseBoatHostKey(publicKey).split(" ")[1];
  // Install an already restricted, expiring key in ONE operation. The provider
  // sshkey endpoint first installs an unrestricted login and has a crash gap.
  // Comment out exactly this public key in place. Never truncate/rewrite the
  // whole file: the provider may append another bootstrap key concurrently.
  // This runs as Boat's setup user, never as root or the workspace identity.
  if (
    restriction &&
    (!Number.isSafeInteger(restriction.seconds) ||
      restriction.seconds < 1 ||
      restriction.seconds > 1845 ||
      !/^\/usr\/bin\/sudo -n \/usr\/bin\/timeout --signal=TERM --kill-after=5s [0-9]+s /.test(
        restriction.command,
      ) ||
      /[\r\n\0]/.test(restriction.command))
  )
    throw invalidAccess();
  const append = restriction
    ? `
 import datetime,json
 expiry=(datetime.datetime.now(datetime.timezone.utc)+datetime.timedelta(seconds=${restriction.seconds})).strftime('%Y%m%d%H%M%SZ')
 command=${JSON.stringify(restriction.command)}
 restricted=('restrict,expiry-time="'+expiry+'",command='+json.dumps(command)+' ssh-ed25519 ${key} zeros-bootstrap\\n').encode()
 if data and not data.endswith(b'\\n'): restricted=b'\\n'+restricted
 if len(data)+len(restricted)>1048576: raise RuntimeError('key file full')
 output=os.open('authorized_keys',os.O_WRONLY|os.O_APPEND|os.O_NOFOLLOW,dir_fd=directory)
 try:
  appended=os.fstat(output)
  if appended.st_ino!=st.st_ino or appended.st_dev!=st.st_dev: raise RuntimeError('key file replaced')
  if os.write(output,restricted)!=len(restricted): raise RuntimeError('short key write')
  os.fsync(output)
 finally:
  os.close(output)`
    : "";
  return `/usr/bin/python3 - <<'PY'
import os,fcntl,stat
home=os.open('/home/user',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
hs=os.fstat(home)
if hs.st_uid!=os.getuid() or hs.st_mode&0o022: raise RuntimeError('unsafe login home')
try: os.mkdir('.ssh',0o700,dir_fd=home)
except FileExistsError: pass
directory=os.open('.ssh',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=home)
ds=os.fstat(directory)
if ds.st_uid!=os.getuid() or ds.st_mode&0o022: raise RuntimeError('unsafe key directory')
try:
 fd=os.open('authorized_keys',os.O_RDWR|os.O_NOFOLLOW|os.O_NONBLOCK${restriction ? "|os.O_CREAT" : ""},0o600,dir_fd=directory)
except FileNotFoundError:
 ${restriction ? "raise RuntimeError('key file missing')" : "print('revoked');raise SystemExit(0)"}
try:
 fcntl.flock(fd,fcntl.LOCK_EX)
 st=os.fstat(fd)
 if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1 or st.st_uid!=os.getuid() or st.st_mode&0o022 or st.st_size>1048576: raise RuntimeError('unsafe key file')
 data=os.read(fd,1048577)
 if len(data)<st.st_size: raise RuntimeError('short key read')
 offset=0
 for line in data.splitlines(keepends=True):
  parts=line.split()
  if not line.lstrip().startswith(b'#') and b'ssh-ed25519' in parts:
   i=parts.index(b'ssh-ed25519')
   if i+1<len(parts) and parts[i+1]==b'${key}':
    if os.pwrite(fd,b'#',offset)!=1: raise RuntimeError('short key write')
  offset+=len(line)
 os.fsync(fd)${append}
 current=os.stat('authorized_keys',dir_fd=directory,follow_symlinks=False)
 if current.st_ino!=st.st_ino or current.st_dev!=st.st_dev: raise RuntimeError('key file replaced')
 print('${restriction ? "restricted" : "revoked"}')
finally:
 os.close(fd)
 os.close(directory)
 os.close(home)
PY`;
}

/** Boat commands do not have a separate stdin/environment carrier. Use its
 * authenticated API only for public SSH material, and use pinned OpenSSH for
 * the one-use setup admission. No plaintext secret file is put in the VM. */
export class BoatSetupCommandRunner implements CloudWorkspaceCommandRunner {
  constructor(
    private readonly options: {
      client: Pick<BoatApiClient, "request">;
      assertOwned(resourceId: string): Promise<void>;
      maxTimeoutSeconds: number;
      maxOutputBytes: number;
      openChannel?: (signal: AbortSignal) => Promise<BoatBootstrapChannel>;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxTimeoutSeconds) ||
      options.maxTimeoutSeconds < 1 ||
      options.maxTimeoutSeconds > 1800 ||
      !Number.isSafeInteger(options.maxOutputBytes) ||
      options.maxOutputBytes < 128 ||
      options.maxOutputBytes > 1024 * 1024
    ) {
      throw new Error("Invalid Boat bootstrap bounds");
    }
  }

  async execute(
    input: Parameters<CloudWorkspaceCommandRunner["execute"]>[0],
    signal: AbortSignal,
  ): Promise<CommandResult> {
    const encoded = input.env?.[SETUP_ENV];
    if (
      !BOAT_RESOURCE_ID_PATTERN.test(input.resourceId) ||
      input.command !== CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND ||
      (input.cwd !== undefined && input.cwd !== "/") ||
      !encoded ||
      !/^[A-Za-z0-9_-]+$/.test(encoded) ||
      encoded.length > 48 * 1024 ||
      Object.keys(input.env ?? {}).length !== 1 ||
      !Number.isSafeInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < 1 ||
      input.timeoutSeconds > this.options.maxTimeoutSeconds
    ) {
      throw new CloudProviderError(
        "provider_command_invalid",
        "Boat accepts only the fixed setup admission",
        false,
      );
    }
    signal.throwIfAborted();
    await this.options.assertOwned(input.resourceId);
    const channel = await (this.options.openChannel?.(signal) ??
      openBoatBootstrapChannel(this.options.maxOutputBytes, signal));
    let installed = false;
    let result: CommandResult | undefined;
    let failure: CloudProviderError | undefined;
    try {
      // Boat cold resume restores disk, not the image's OCI entrypoint or /run.
      // This fixed, secret-free helper probes or starts the one root broker;
      // it cannot replace an active engine or consume a launch admission.
      const prepared = await this.options.client.request(
        `/sandboxes/${input.resourceId}/commands`,
        {
          method: "POST",
          body: { command: ENSURE_SUPERVISOR_COMMAND, timeoutSeconds: 20 },
          signal,
        },
      );
      if (
        prepared.success !== true ||
        prepared.exitCode !== 0 ||
        prepared.timedOut ||
        prepared.stdoutTruncated ||
        prepared.stdout !== "ready\n"
      )
        throw new CloudProviderError(
          "provider_bootstrap_unavailable",
          "Boat runtime broker is not ready",
          true,
        );
      const key = await this.options.client.request(
        `/sandboxes/${input.resourceId}/commands`,
        {
          method: "POST",
          body: { command: HOST_KEY_COMMAND, timeoutSeconds: 15 },
          signal,
        },
      );
      if (
        key.success !== true ||
        key.exitCode !== 0 ||
        key.timedOut ||
        key.stdoutTruncated
      )
        throw invalidAccess();
      const hostPublicKey = parseBoatHostKey(key.stdout);
      parseBoatHostKey(channel.publicKey);
      const access = await this.options.client.request(
        `/sandboxes/${input.resourceId}`,
        { signal },
      );
      const sandbox = access.sandbox as
        | { id?: unknown; ip?: unknown; sshEndpoint?: unknown }
        | undefined;
      if (sandbox?.id !== input.resourceId) throw invalidAccess();
      const endpoint = parseBoatSshEndpoint(sandbox);
      const command = `/usr/bin/sudo -n /usr/bin/timeout --signal=TERM --kill-after=5s ${input.timeoutSeconds}s ${CLOUD_WORKSPACE_LINUX_SETUP_HELPER_COMMAND} --stdin`;
      installed = true;
      const restricted = await this.options.client.request(
        `/sandboxes/${input.resourceId}/commands`,
        {
          method: "POST",
          body: {
            command: boatAuthorizedKeyCommand(channel.publicKey, {
              command,
              seconds: input.timeoutSeconds + 45,
            }),
            timeoutSeconds: 15,
          },
          signal,
        },
      );
      if (
        restricted.success !== true ||
        restricted.exitCode !== 0 ||
        restricted.timedOut ||
        restricted.stdoutTruncated ||
        restricted.stdout !== "restricted\n"
      )
        throw invalidAccess();
      result = await channel.execute(
        {
          resourceId: input.resourceId,
          ...endpoint,
          hostPublicKey,
          command,
          stdin: encoded,
          timeoutSeconds: input.timeoutSeconds,
        },
        signal,
      );
    } catch (error) {
      failure =
        error instanceof CloudProviderError
          ? error
          : new CloudProviderError(
              "provider_command_unconfirmed",
              "Boat setup execution could not be confirmed",
              true,
            );
    } finally {
      try {
        if (installed) {
          const revoked = await this.options.client.request(
            `/sandboxes/${input.resourceId}/commands`,
            {
              method: "POST",
              body: {
                command: boatAuthorizedKeyCommand(channel.publicKey),
                timeoutSeconds: 15,
              },
              signal: AbortSignal.timeout(20_000),
            },
          );
          if (
            revoked.success !== true ||
            revoked.exitCode !== 0 ||
            revoked.timedOut ||
            revoked.stdoutTruncated ||
            revoked.stdout !== "revoked\n"
          )
            throw new Error("revocation unconfirmed");
        }
      } catch {
        failure = new CloudProviderError(
          "provider_bootstrap_cleanup_unconfirmed",
          "Boat bootstrap access cleanup could not be confirmed",
          true,
        );
      } finally {
        try {
          await channel.dispose();
        } catch {
          failure = new CloudProviderError(
            "provider_bootstrap_cleanup_unconfirmed",
            "Boat bootstrap access cleanup could not be confirmed",
            true,
          );
        }
      }
    }
    if (failure) throw failure;
    return result!;
  }
}
