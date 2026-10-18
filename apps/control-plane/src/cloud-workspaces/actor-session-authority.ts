import { ROLLOUT_FLAGS_OFF, type RolloutFlagReader } from "../rollout-flags.js";
import type { CloudWorkspaceCapability } from "./actors.js";
import type { CapabilityClientScope } from "./capability-contract.js";

let flags: RolloutFlagReader = ROLLOUT_FLAGS_OFF;

/** Installed at CP composition, like the engine authority cache. Every
 * indirect actor reader sees the same memory-only, fail-closed selection. */
export function installCapabilityActorSessionFlags(reader?: RolloutFlagReader): void {
  flags = reader ?? ROLLOUT_FLAGS_OFF;
}

export function capabilityActorSessionsEnabled(organizationId: string, reader: RolloutFlagReader = flags): boolean {
  return (["capability_actor_sessions", "capabilities", "runtime_connect", "realtime_uplink"] as const)
    .every(flag => reader.enabled(organizationId, flag));
}

const scopes: Record<CloudWorkspaceCapability, CapabilityClientScope> = {
  read: "ws:read", run: "ws:prompt", edit: "ws:edit", manage: "ws:manage", credentials: "ws:manage", delete: "ws:manage",
};
export function actorCapabilityScope(capability: CloudWorkspaceCapability): CapabilityClientScope {
  return scopes[capability];
}
