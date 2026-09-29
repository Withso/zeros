import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { releaseSource, requireCheck } from "./contracts";
import { classifyChanges, changedFiles, workerInputsSha256 } from "./source";

async function main() {
  const source = releaseSource(process.env);
  const mode = process.argv[2];
  requireCheck(mode === "--plan" || mode === "--execute", "Worker lane requires --plan or --execute");
  const changes = classifyChanges(await changedFiles(source.sourceSha, process.env.RELEASE_BASE));
  const plan = { version: 1, status: "plan", ...source, inputsChanged: changes.worker, inputsSha256: await workerInputsSha256(source.sourceSha),
    enabled: process.env.ZEROS_WORKER_PROMOTION === "enabled",
    stages: ["clean-exact-source", "boat-image-kit", "attest-sanitize-save", "native-ci-canaries", "cleanup-proof", "same-owner-plan-execute", "atomic-worker-tuple"],
    liveBlocker: "Release canary credential broker/transport and Codex native-cache renewal proof require isolated live rehearsal. Dev credential-dispatch authorization is not accepted." };
  await mkdir(".context/release", { recursive: true, mode: 0o700 });
  await writeFile(".context/release/worker-plan.json", JSON.stringify(plan, null, 2), { mode: 0o600 });
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
    `Worker promotion: ${plan.enabled ? "enabled" : "disabled"}; input changes: ${plan.inputsChanged}. This is a plan, not qualification or promotion. ${plan.liveBlocker}\n`);
  if (mode === "--plan") { console.log("Worker promotion plan saved; no provider mutations performed."); return; }
  requireCheck(plan.enabled, "Worker promotion is disabled");
  // Fail before allocating any paid/credential-bearing resource. The tested
  // adapters in worker-adapters.ts are intentionally not connected to a Dev
  // authorization bypass to manufacture a release qualification receipt.
  throw new Error(plan.liveBlocker);
}
void main().catch(() => {
  console.error("::error::Worker execution is blocked pending release-specific native canary transport rehearsal. No worker promotion receipt was issued; hosted and desktop publication must remain blocked for changed worker inputs.");
  process.exitCode = 1;
});
