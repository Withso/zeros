import { appendFile } from "node:fs/promises";
import { CHANNELS, PromotionError, releaseSource, requireCheck } from "./contracts";
import { disabledGuard, publicIdentity } from "./guard";
import { githubClient } from "./github";
import { command, jsonClient } from "./io";
import { publicationGate } from "./publication";

async function main() {
  const source = releaseSource(process.env);
  requireCheck((await command("git", ["rev-parse", "HEAD"])).trim() === source.sourceSha, "Publication checkout differs from the event SHA");
  // Packaging changes package.json. Read manifests from Git objects, and
  // refresh rolling refs at publication rather than trusting checkout time.
  await command("git", ["fetch", "--force", "--prune", "--prune-tags", "--tags", "origin"]);
  const cloudRequired = process.env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true", provider = process.env.CLOUD_WORKSPACE_PROVIDER || "daytona";
  if (process.env.ZEROS_HOSTED_PROMOTION !== "enabled") {
    const result = await disabledGuard([], { ...source, cloudEnabled: cloudRequired, provider });
    console.log(`::${result.blocked ? "error" : "warning"}::${result.message}`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.message}\n`);
    requireCheck(!result.blocked, "Publication guard refused this candidate");
    return;
  }
  const config = { ...source, cloudRequired, provider, runId: process.env.GITHUB_RUN_ID ?? "" };
  const github = githubClient(source, process.env), json = jsonClient();
  await publicationGate(config, {
    receipt: () => github.ownReceipt(source.channel, config.runId),
    identity: async () => (await publicIdentity(source.channel)).identity,
    page: surface => json(`${CHANNELS[source.channel][surface]}/zeros-deployment.json`),
  });
  const message = `Current hosted receipt and channel identities verified for ${source.channel} at ${source.sourceSha}; desktop publication may proceed.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
void main().catch(error => {
  console.error(`::error::${error instanceof PromotionError ? error.message : "Publication proof failed; private diagnostics withheld"}`);
  process.exitCode = 1;
});
