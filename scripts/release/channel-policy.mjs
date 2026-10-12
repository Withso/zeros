import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const channels = JSON.parse(readFileSync(new URL("../../apps/control-plane/src/cloud-workspace-channels.json", import.meta.url), "utf8"));

/** Apply the checked-in pause before any cloud build/qualification decisions.
 * Existing environment opt-outs remain valid on channels that allow cloud. */
export function releaseChannelEnvironment(channel, environment) {
  if (!Object.hasOwn(channels, channel) || typeof channels[channel] !== "boolean")
    throw new Error("Unknown cloud release channel");
  const allowed = channels[channel];
  if (allowed && ![undefined, "", "false", "true"].includes(environment.ZEROS_CLOUD_WORKSPACES_ENABLED))
    throw new Error("Invalid desktop cloud capability");
  return {
    ZEROS_CLOUD_WORKSPACES_ENABLED: allowed && environment.ZEROS_CLOUD_WORKSPACES_ENABLED === "true" ? "true" : "false",
    ZEROS_WORKER_PROMOTION: allowed && environment.ZEROS_WORKER_PROMOTION === "enabled" ? "enabled" : "disabled",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--github-env" || !process.env.GITHUB_ENV)
    throw new Error("Usage: channel-policy.mjs --github-env in a release job");
  const selected = releaseChannelEnvironment(process.env.RELEASE_CHANNEL, process.env);
  appendFileSync(process.env.GITHUB_ENV, Object.entries(selected).map(([key, value]) => `${key}=${value}\n`).join(""));
}
