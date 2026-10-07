import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS, PromotionError, SHA, requireCheck, type Channel } from "./contracts";
import { githubClient } from "./github";
import { command, type Command } from "./io";

/** Bundle publication has a wider ref matrix than desktop release promotion.
 * Keep this boundary separate from releaseSource's frozen-release contract. */
export function runtimeBundleSource(env: NodeJS.ProcessEnv) {
  const channel = env.RELEASE_CHANNEL as Channel;
  requireCheck(Object.hasOwn(CHANNELS, channel ?? ""), "Runtime bundle channel is invalid");
  const sourceSha = env.RELEASE_SHA ?? "", ref = env.GITHUB_REF ?? "";
  requireCheck(SHA.test(sourceSha) && sourceSha === env.GITHUB_SHA, "Runtime bundle SHA must equal the immutable event SHA");
  const releaseBranch = ref.startsWith("refs/heads/release/") &&
    ref.length > "refs/heads/release/".length && !/\s/.test(ref);
  requireCheck(ref === "refs/heads/main" || channel !== "alpha" && releaseBranch, "Runtime bundle ref does not belong to this channel");
  const branch = ref.slice("refs/heads/".length), repository = env.GITHUB_REPOSITORY ?? "";
  requireCheck(env.RELEASE_BRANCH === branch && /^[\w.-]+\/[\w.-]+$/.test(repository), "Runtime bundle branch or repository identity is invalid");
  requireCheck(env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
    env.GITHUB_WORKFLOW_REF === `${repository}/.github/workflows/cloud-runtime-bundle.yml@${ref}`,
  "Runtime bundle publication requires its standalone dispatch workflow");
  return { channel, sourceSha, branch, repository };
}

export async function verifyRuntimeBundleCI(env: NodeJS.ProcessEnv, dependencies: { fetch?: typeof fetch; command?: Command } = {}) {
  const source = runtimeBundleSource(env);
  requireCheck((await (dependencies.command ?? command)("git", ["rev-parse", "HEAD"])).trim() === source.sourceSha,
    "Runtime bundle CI checkout differs from the event SHA");
  // The manual workflow cannot enter automatic Alpha's fast/admitted paths.
  // Reuse the same bounded, latest-attempt Preflight + CodeQL proof and current
  // branch check as the release CI gate, without any provider mutation.
  const github = githubClient(source, env, dependencies);
  await github.assertRequiredChecks();
  await github.assertCurrent();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void (async () => {
    requireCheck(process.argv.length === 3 && process.argv[2] === "--verify", "Usage: runtime-bundle-ci.ts --verify");
    await verifyRuntimeBundleCI(process.env);
    console.log("Preflight and CodeQL succeeded for the exact runtime bundle source.");
  })().catch(error => {
    console.error(error instanceof PromotionError ? error.message : "Runtime bundle CI proof failed; publication refused.");
    process.exitCode = 1;
  });
}
