import { spawn } from "node:child_process";
import { freeze } from "./check-plan.mjs";
import { runCommand } from "./runner.mjs";
import { hourlySnapshot, decideHourlyGate } from "../zeros-dev/hourly-actions.mjs";

export function planDriver(action, { sourceSha, platform = process.platform, shard } = {}) {
  let command; const unverified = [];
  if (action === "local-ui") {
    if (shard && !/^[1-3]\/3$/.test(shard)) throw new Error("zstack_input_invalid");
    command = { id: "local-ui", kind: "check", argv: ["pnpm", "test:ui-smoke", ...(shard ? [`--shard=${shard}`] : [])] };
    if (platform !== "darwin") unverified.push({ id: "engine-smoke", reason: "requires_macos" });
    if (shard) unverified.push({ id: "remaining-ui-shards", reason: "not_run" });
  } else {
    if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("zstack_input_invalid");
    if (action === "cloud-health") {
      if (platform !== "linux") throw new Error("zstack_requires_linux");
      command = { id: "cloud-health", kind: "check", argv: ["pnpm", "exec", "tsx", "scripts/zeros-dev/cli.ts", "health", "cp", "--expect-source", sourceSha] };
      unverified.push({ id: "cloud-lifecycle", reason: "requires_hourly_e2e" });
    } else if (action === "cloud-dispatch") {
      command = { id: "cloud-dispatch", kind: "check", argv: ["pnpm", "agent:gh", "workflow", "run", "zeros-dev-e2e.yml", "--ref", "main"] };
      unverified.push({ id: "cloud-lifecycle", reason: "await_exact_run" });
    } else if (action === "cloud-status") {
      command = null;
    } else throw new Error("zstack_input_invalid");
  }
  return freeze({ schema: "zeros.zstack-driver/v1", action, requiresExecution: true, intendedSourceSha: sourceSha ?? null, command, unverified });
}

// The existing automation wrapper owns auth. Only its established identity
// variables cross this boundary, and none enter argv, output or the receipt.
export function runDriver(command, options) {
  if (command.id !== "cloud-dispatch") return runCommand(command, options);
  return runCommand(command, { ...options, spawn: (file, argv, config) => spawn(file, argv, { ...config,
    env: { ...config.env, ...Object.fromEntries(["ZEROS_AGENT_GITHUB_APP_B64", "GH_TOKEN", "GITHUB_TOKEN"]
      .filter(key => process.env[key]).map(key => [key, process.env[key]])) } }) });
}

export async function observeHourly(api, sourceSha, { snapshot = hourlySnapshot, now = Date.now() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha ?? "")) throw new Error("zstack_input_invalid");
  try {
    const observation = await snapshot(api), gate = decideHourlyGate(observation, true, now);
    const sourceMatches = observation.latest?.head_sha === sourceSha;
    const code = !sourceMatches ? "source_mismatch" : gate.code;
    return { status: code === "hourly_green" ? "passed" : "unverified", code,
      sourceSha: observation.latest?.head_sha ?? null, runId: observation.latest ? String(observation.latest.id) : null,
      attempt: observation.latest?.run_attempt ?? null, completedAt: observation.completedAt,
      unverified: [{ id: "local-working-tree", reason: "main_only_canary" }] };
  } catch { return { status: "unverified", code: "hourly_unavailable" }; }
}
