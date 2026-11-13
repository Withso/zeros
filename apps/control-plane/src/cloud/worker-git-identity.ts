import type { CloudV2ControlFrame } from "./contract.js";

type Config = Extract<CloudV2ControlFrame, { t: "config" }>;

export function workerGitIdentity(config: Config, identity: boolean, creator: boolean): Pick<Config, "gitIdentity" | "gitIdentitySource"> {
  if (config.actingUser === 1) {
    if (creator && config.gitIdentitySource) return { gitIdentitySource: config.gitIdentitySource, gitIdentity: config.gitIdentity ?? null };
    return identity ? { gitIdentity: null } : {};
  }
  return identity && config.gitIdentity !== undefined ? { gitIdentity: config.gitIdentity } : {};
}
