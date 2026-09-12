// ──────────────────────────────────────────────────────────
// ssh-forward.ts — validate the `ssh -L` fallback path.
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-workspace-validation/ssh-forward.ts
//
// Daytona's gateway is a transparent channel proxy and the daemon registers
// `direct-tcpip` — so `ssh -L` SHOULD work (source-confirmed, undocumented). This
// confirms it hands-on: open an SSH local-forward from a random local port to the
// engine's cloud port inside the box, then curl the forwarded /health. A 200 ⇒
// `ssh -L` works (gates the later "Open in Cursor / forward a port" feature — NOT
// the bridge, which rides the preview WSS).
//
// Requires the `ssh` + `curl` binaries on the host.
// ──────────────────────────────────────────────────────────

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadState, ENGINE_CLOUD_PORT } from "./config";
import { makeQualifiedControlPlaneProvider } from "./control-plane-provider";
import { requireHttpRoundTrip } from "./lib/qualification-gates";

async function reserveLocalPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("could not reserve an SSH forwarding port");
  }
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function validatedSshTarget(command: string, token: string): string {
  const fields = command.trim().split(/\s+/);
  if (
    fields.length !== 2 ||
    fields[0] !== "ssh" ||
    !fields[1].startsWith(`${token}@`)
  ) {
    throw new Error("provider returned an invalid SSH command");
  }
  const host = fields[1].slice(token.length + 1);
  if (
    !host ||
    host.length > 253 ||
    !/^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(
      host,
    )
  ) {
    throw new Error("provider returned an invalid SSH gateway host");
  }
  return fields[1];
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) =>
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 2_000),
    ),
  ]);
}

function curlHealth(port: number): Promise<{ code: number; body: string }> {
  return new Promise((resolve) => {
    const child = spawn("curl", [
      "-s",
      "-o",
      "-",
      "-w",
      "\n%{http_code}",
      "--max-time",
      "8",
      `http://127.0.0.1:${port}/health`,
    ]);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => {
      const nl = out.lastIndexOf("\n");
      const code = Number(out.slice(nl + 1).trim()) || 0;
      resolve({ code, body: out.slice(0, nl) });
    });
    child.on("error", () => resolve({ code: 0, body: "" }));
  });
}

async function main() {
  const state = loadState();
  const provider = makeQualifiedControlPlaneProvider();

  console.log(
    `\n  Requesting SSH access (60 min) for sandbox ${state.sandboxId}…`,
  );
  const ssh = await provider.createSshAccess(state.sandboxId, 60);
  let sshProc: ChildProcess | null = null;
  const knownHostsDir = mkdtempSync(path.join(tmpdir(), "zeros-ssh-host-"));
  let failure: unknown = null;
  try {
    // Use the provider-returned command only as structured data; never execute
    // it through a shell. No token fragment or provider stderr reaches logs.
    const target = validatedSshTarget(ssh.command, ssh.credential);
    const localPort = await reserveLocalPort();
    console.log(
      `  Opening a token-authenticated ssh -L tunnel to engine port ${ENGINE_CLOUD_PORT} …`,
    );
    sshProc = spawn(
      "ssh",
      [
        "-N",
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        `UserKnownHostsFile=${path.join(knownHostsDir, "known_hosts")}`,
        "-o",
        "LogLevel=ERROR",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ConnectTimeout=15",
        "-L",
        `${localPort}:127.0.0.1:${ENGINE_CLOUD_PORT}`,
        target,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    // Drain stderr so the child cannot block, but never retain or print it: SSH
    // diagnostics may echo its bearer username.
    sshProc.stderr?.resume();

    let result = { code: 0, body: "" };
    for (let i = 0; i < 8 && result.code === 0; i++) {
      if (sshProc.exitCode !== null || sshProc.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      result = await curlHealth(localPort);
    }
    requireHttpRoundTrip("SSH forward /health round trip", result.code);
    console.log(
      `\n  \x1b[32m✓ ssh -L works\x1b[0m — forwarded /health returned 200.`,
    );
    console.log(
      `    → the "Open in Cursor / forward a port" fallback is viable.\n`,
    );
  } catch (error) {
    failure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    if (sshProc) {
      try {
        await stopChild(sshProc);
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    try {
      await provider.revokeSshAccess(state.sandboxId);
    } catch (error) {
      cleanupFailures.push(error);
    }
    rmSync(knownHostsDir, { recursive: true, force: true });
    if (failure && cleanupFailures.length > 0) {
      throw new AggregateError(
        [failure, ...cleanupFailures],
        "SSH forward failed and credential cleanup was incomplete",
      );
    }
    if (failure) throw failure;
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        cleanupFailures,
        "SSH credential cleanup was incomplete",
      );
    }
  }
}

main().catch((err) => {
  console.error("\n  ✗ ssh-forward failed:\n", err);
  process.exit(1);
});
