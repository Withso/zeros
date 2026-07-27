// ──────────────────────────────────────────────────────────
// ssh-forward.ts — §14 #6: does `ssh -L` local-forward work?
// ──────────────────────────────────────────────────────────
//
//   pnpm tsx scripts/cloud-spike/ssh-forward.ts
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

import { spawn } from "node:child_process";
import { loadState, makeDaytona, ENGINE_CLOUD_PORT } from "./config";

const LOCAL_PORT = 38555;

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
  const daytona = makeDaytona();
  const sandbox = await daytona.get(state.sandboxId);

  console.log(`\n  Requesting SSH access (60 min) for sandbox ${state.sandboxId}…`);
  const ssh = await sandbox.createSshAccess(60);
  // Daytona's sshCommand looks like `ssh <token>@ssh.app.daytona.io`. Parse the
  // `user@host` target from it so we don't hardcode the gateway hostname.
  const m = ssh.sshCommand.match(/ssh\s+(\S+@\S+)/);
  const target = m ? m[1] : `${ssh.token}@ssh.app.daytona.io`;
  console.log(`  target: ${target.replace(ssh.token, ssh.token.slice(0, 6) + "…")}`);

  console.log(`  Opening ssh -L ${LOCAL_PORT}:127.0.0.1:${ENGINE_CLOUD_PORT} …`);
  const sshProc = spawn(
    "ssh",
    [
      "-N",
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ConnectTimeout=15",
      "-L", `${LOCAL_PORT}:127.0.0.1:${ENGINE_CLOUD_PORT}`,
      target,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let sshErr = "";
  sshProc.stderr.on("data", (d) => (sshErr += d.toString()));

  // Give the tunnel a moment, then probe the forwarded /health a few times.
  let result = { code: 0, body: "" };
  for (let i = 0; i < 8 && result.code === 0; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    result = await curlHealth(LOCAL_PORT);
  }

  sshProc.kill("SIGTERM");
  await sandbox.revokeSshAccess(ssh.token).catch(() => {});

  console.log("");
  if (result.code === 200) {
    console.log(`  \x1b[32m✓ ssh -L works\x1b[0m — forwarded /health returned 200.`);
    console.log(`    → the "Open in Cursor / forward a port" feature is viable.\n`);
  } else {
    console.log(`  \x1b[33m⚠ ssh -L did not complete a /health round-trip\x1b[0m (got ${result.code || "no response"}).`);
    if (sshErr.trim()) console.log(`    ssh stderr: ${sshErr.trim().split("\n").slice(-3).join(" | ")}`);
    console.log(`    Either the engine wasn't up on :${ENGINE_CLOUD_PORT}, or -L is gated. Record in §14 #6.\n`);
  }
}

main().catch((err) => {
  console.error("\n  ✗ ssh-forward failed:\n", err);
  process.exit(1);
});
