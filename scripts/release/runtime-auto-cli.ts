import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudWorkspaceChannelEnabled } from "../../apps/control-plane/src/cloud/channel-policy";
import { PromotionError, releaseSource, requireCheck } from "./contracts";
import { command, jsonClient, type Command } from "./io";
import { runtimeBuildConfig, runtimeOrigin } from "./runtime-contracts";
import { runtimeCaller } from "./runtime-caller";
import { runtimeGithub } from "./runtime-github";
import { resolveRuntimeRelease, waitForRuntimeCI } from "./runtime-auto";
import { runtimePublicationAttempt } from "./runtime-proof";

export async function runtimeAutoMain(args = process.argv.slice(2), env = process.env, options: { command?: Command; fetch?: typeof fetch } = {}) {
  requireCheck(args.length === 1 && ["--resolve", "--wait-ci"].includes(args[0]), "Usage: runtime-auto-cli.ts --resolve | --wait-ci in a release workflow");
  if (args[0] === "--wait-ci") {
    const config = runtimeBuildConfig(env), github = runtimeGithub(config, env, options);
    await waitForRuntimeCI(config, github.read);
    await github.source();
    return;
  }
  const source = releaseSource(env), execute = options.command ?? command, json = jsonClient(options.fetch);
  const file = { alpha: "release-alpha.yml", beta: "release-beta.yml", production: "release.yml" } as const;
  const caller = runtimeCaller(file[source.channel], source.channel, source.channel === "alpha" ? "publish" : "promote");
  requireCheck(env.GITHUB_EVENT_NAME === caller.event && env.GITHUB_REF === `refs/heads/${source.branch}` &&
    env.GITHUB_WORKFLOW_REF === `${source.repository}/${caller.path}@refs/heads/${source.branch}` && env.GITHUB_WORKFLOW_SHA === source.sourceSha,
    "Automatic runtime resolution requires the exact release parent");
  requireCheck([undefined, "", "false", "true"].includes(env.ZEROS_CLOUD_WORKSPACES_ENABLED), "Invalid desktop cloud capability");
  const cloudEnabled = cloudWorkspaceChannelEnabled(source.channel) && env.ZEROS_CLOUD_WORKSPACES_ENABLED === "true";
  requireCheck(!cloudEnabled || env.ZEROS_RUNTIME_RELEASE === "enabled" && env.ZEROS_HOSTED_PROMOTION === "enabled",
    "Cloud release requires runtime and hosted promotion to be enabled");
  requireCheck((await execute("git", ["rev-parse", "HEAD"])).trim() === source.sourceSha, "Runtime resolver checkout differs from the release source");
  requireCheck(env.GITHUB_OUTPUT && env.GITHUB_STEP_SUMMARY, "Runtime resolution requires workflow output files");
  const plan = await resolveRuntimeRelease({ ...source, cloudEnabled }, {
    identity: channel => json(`${runtimeOrigin(channel)}/v1/release-identity`, { cache: "no-store" }),
    ancestor: async (before, after) => (await execute("git", ["merge-base", before, after])).trim() === before,
    changes: async (before, after) => (await execute("git", ["diff", "--name-only", "--no-renames", "-z", before, after, "--"])).split("\0").filter(Boolean),
    published: async proof => !!await runtimePublicationAttempt(source.repository, proof, path => json(`https://api.github.com/repos/${source.repository}${path}`, {
      headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    })),
  });
  await appendFile(env.GITHUB_OUTPUT, Object.entries(plan).map(([key, value]) => `${key}=${value}\n`).join(""));
  await appendFile(env.GITHUB_STEP_SUMMARY, `Cloud runtime: ${plan.action} (${plan.reason}).\n`);
  return plan;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runtimeAutoMain().catch(error => {
  console.error(error instanceof PromotionError ? error.message : "Runtime resolution failed; downstream publication refused");
  process.exitCode = 1;
});
