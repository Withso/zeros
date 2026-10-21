import { freeze } from "./check-plan.mjs";
import { runCommand } from "./runner.mjs";

export function planDriver(action, { sourceSha, platform = process.platform, shard } = {}) {
  if (action !== "local-ui") throw new Error("zstack_input_invalid");
  if (shard && !/^[1-3]\/3$/.test(shard)) throw new Error("zstack_input_invalid");
  const unverified = [];
  const command = { id: "local-ui", kind: "check", argv: ["pnpm", "test:ui-smoke", ...(shard ? [`--shard=${shard}`] : [])] };
  if (platform !== "darwin") unverified.push({ id: "engine-smoke", reason: "requires_macos" });
  if (shard) unverified.push({ id: "remaining-ui-shards", reason: "not_run" });
  return freeze({ schema: "zeros.zstack-driver/v1", action, requiresExecution: true, intendedSourceSha: sourceSha ?? null, command, unverified });
}

export function runDriver(command, options) {
  return runCommand(command, options);
}
