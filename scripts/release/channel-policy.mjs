import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const channels = JSON.parse(readFileSync(new URL("../../apps/control-plane/src/cloud/channels.json", import.meta.url), "utf8"));

/** Apply the checked-in pause before any cloud release decisions.
 * Existing environment opt-outs remain valid on channels that allow cloud.
 * Tests pass `policy` to exercise a pause the checked-in file does not set. */
export function releaseChannelEnvironment(channel, environment, policy = channels) {
  if (!Object.hasOwn(policy, channel) || typeof policy[channel] !== "boolean")
    throw new Error("Unknown cloud release channel");
  const allowed = policy[channel];
  if (allowed && ![undefined, "", "false", "true"].includes(environment.ZEROS_CLOUD_WORKSPACES_ENABLED))
    throw new Error("Invalid desktop cloud capability");
  return {
    ZEROS_CLOUD_WORKSPACES_ENABLED: allowed && environment.ZEROS_CLOUD_WORKSPACES_ENABLED === "true" ? "true" : "false",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== "--github-env" || !process.env.GITHUB_ENV)
    throw new Error("Usage: channel-policy.mjs --github-env in a release job");
  const selected = releaseChannelEnvironment(process.env.RELEASE_CHANNEL, process.env);
  appendFileSync(process.env.GITHUB_ENV, Object.entries(selected).map(([key, value]) => `${key}=${value}\n`).join(""));
}
