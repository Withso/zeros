#!/usr/bin/env node
// pnpm cloud:local — this branch's cloud workspaces on one machine, the cloud
// counterpart of electron:local. It runs the local Dev launcher: an isolated
// PostgreSQL with this branch's migrations, this branch's control plane, a
// named Cloudflare tunnel that Boat VMs reach, and the desktop app pointed at
// it. Nothing is created in Railway or PlanetScale.
//
//   pnpm cloud:local --runtime <sha256>   start everything and open the app
//   pnpm cloud:local --headless           backend only, for agents and gate0
//   pnpm cloud:local --seed               seed a running stack's test organization
//   pnpm cloud:local --stop | --doctor
//   pnpm cloud:local --reset [--yes]      delete this checkout's VMs and data
//
// The runtime is a worker build published with cloud-v2:publish-runtime; it
// may also come from ZEROS_CLOUD_V2_RUNTIME_SHA256.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODES = { "--headless": "backend", "--stop": "stop", "--doctor": "doctor", "--seed": "seed", "--reset": "archive" };
const SHA256 = /^[0-9a-f]{64}$/;

/** Pure flag parsing; `defaultRuntime` is for tests and callers that pin one. */
export function cloudLocalCommand(argv, env = process.env, defaultRuntime = undefined) {
  const modes = argv.filter(arg => Object.hasOwn(MODES, arg));
  if (modes.length > 1) throw new Error(`Use one of ${Object.keys(MODES).join(", ")}`);
  const action = modes.length ? MODES[modes[0]] : "start";
  const args = [];
  let runtime = env.ZEROS_CLOUD_V2_RUNTIME_SHA256 || defaultRuntime;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (Object.hasOwn(MODES, arg)) continue;
    if (arg === "--runtime") {
      runtime = argv[++index];
      if (!SHA256.test(runtime ?? "")) throw new Error("--runtime needs the published worker runtime's sha256");
      continue;
    }
    if (arg === "--run-only") { args.push(arg); continue; }
    if (arg === "--yes" && action === "archive") { args.push(arg); continue; }
    throw new Error(`Unknown cloud:local option ${arg}`);
  }
  if (!["start", "backend"].includes(action)) return { action, args, runtime: undefined };
  if (!SHA256.test(runtime ?? ""))
    throw new Error("cloud:local needs a worker runtime: pass --runtime <sha256> from cloud-v2:publish-runtime, or set ZEROS_CLOUD_V2_RUNTIME_SHA256");
  return { action, args, runtime };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let command;
  try { command = cloudLocalCommand(process.argv.slice(2)); }
  catch (error) { console.error(`[cloud:local] ${error.message}`); process.exit(2); }
  const launcher = path.join(path.dirname(fileURLToPath(import.meta.url)), "dev-environment/launcher.mjs");
  const env = { ...process.env, ...(command.runtime ? { ZEROS_CLOUD_V2_RUNTIME_SHA256: command.runtime } : {}) };
  const child = spawn(process.execPath, [launcher, command.action, ...command.args], { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
