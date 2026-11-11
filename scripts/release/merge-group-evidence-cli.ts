import { appendFile } from "node:fs/promises";
import { mergeGroupPreflight } from "./alpha-ci";
import { SHA } from "./contracts";
import { jsonClient } from "./io";

type Read = (route: string) => Promise<any>;

/** Whether this push to main may skip Preflight's workloads: only a push of
 * exactly a merge-group commit whose own Preflight already succeeded (the
 * same predicate the Alpha barrier accepts). Any doubt runs everything. */
export async function pushCoveredByMergeGroup(env: NodeJS.ProcessEnv, read: Read) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF !== "refs/heads/main" || !SHA.test(env.GITHUB_SHA ?? "") ||
    !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) return null;
  try { return await mergeGroupPreflight({ repository: env.GITHUB_REPOSITORY!, sourceSha: env.GITHUB_SHA! }, read); }
  catch { return null; }
}

async function main() {
  const json = jsonClient();
  const read: Read = route => json(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${route}`, { headers: {
    authorization: `Bearer ${process.env.GH_TOKEN}`, accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
  const covered = await pushCoveredByMergeGroup(process.env, read);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `covered=${covered ? "true" : "false"}\n`);
  console.log(covered
    ? `::notice::Merge-group Preflight run ${covered.runId} attempt ${covered.attempt} already passed on exactly this commit; this push skips its duplicated workloads.`
    : "No successful merge-group Preflight for exactly this commit; this push runs every workload.");
}

if (process.argv[1]?.endsWith("merge-group-evidence-cli.ts")) void main().catch(() => {
  // Fail closed to a full run; never fail the push run over the shortcut.
  console.log("Merge-group evidence unavailable; this push runs every workload.");
  if (process.env.GITHUB_OUTPUT) void appendFile(process.env.GITHUB_OUTPUT, "covered=false\n");
});
