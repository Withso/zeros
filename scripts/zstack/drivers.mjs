import { freeze } from "./check-plan.mjs";
import { zstackEntry } from "./render.mjs";
import { runCommand } from "./runner.mjs";

export function planHost({ host = "portable", platform = process.platform, canDelegate = false, delegates = [], models = {} } = {}) {
  const entry = zstackEntry(host), roles = { implementer: "primary", reviewer: "cold-pass" };
  const requested = new Set(delegates);
  if (requested.size !== delegates.length || delegates.some(role => !Object.hasOwn(roles, role)))
    throw new Error("zstack_input_invalid");
  const planned = Object.fromEntries(Object.entries(roles).map(([role, fallback]) => {
    const model = models[role];
    if (model !== undefined && (!requested.has(role) || !/^[a-z\d][a-z\d ./_:+@()-]{0,99}$/i.test(model)))
      throw new Error("zstack_input_invalid");
    if (!requested.has(role)) return [role, { execution: fallback, model: "inherit" }];
    if (!canDelegate) return [role, { execution: fallback, model: "inherit", reason: "delegation_unavailable" }];
    return [role, { execution: "delegated", model: model ?? "inherit" }];
  }));
  return freeze({ schema: "zeros.zstack-host/v1", host, platform, entry, reportedDelegation: canDelegate,
    mode: canDelegate && requested.size ? "master-subagents" : "single-session", roles: planned });
}

export function planDriver(action, { sourceSha, platform = process.platform, shard } = {}) {
  if (action !== "local-ui") throw new Error("zstack_input_invalid");
  if (shard && !/^[1-3]\/3$/.test(shard)) throw new Error("zstack_input_invalid");
  const unverified = [{ id: "engine-smoke", reason: platform === "darwin" ? "not_run" : "requires_macos" }];
  const command = { id: "local-ui", kind: "check", argv: ["pnpm", "test:ui-smoke", ...(shard ? [`--shard=${shard}`] : [])] };
  if (shard) unverified.push({ id: "remaining-ui-shards", reason: "not_run" });
  return freeze({ schema: "zeros.zstack-driver/v1", action, requiresExecution: true, intendedSourceSha: sourceSha ?? null, command, unverified });
}

export function runDriver(command, options) {
  return runCommand(command, options);
}
