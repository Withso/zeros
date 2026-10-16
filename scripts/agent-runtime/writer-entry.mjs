// Bundled from trusted main in the scanner job before any candidate executes.
// This job installs nothing and never imports or executes preparation output.
import { writeFileSync } from "node:fs";
import { GitHub } from "./github.mjs";
import { LIMITS } from "./config.mjs";
import { invariant, parseJson, validateTask } from "./contracts.mjs";
import { readArtifact, validateRun } from "./artifacts.mjs";
import { validatePrepared, workflowContext } from "./controller.mjs";
import { writePreparedProposal } from "./writer.mjs";

async function main() {
  const context = workflowContext();
  invariant(
    process.env.ZEROS_AGENT_RUNTIME_MODE === "enabled",
    "The runtime branch writer is disabled.",
  );
  invariant(
    process.env.RUNTIME_APP_SLUG === process.env.ZEROS_AGENT_RUNTIME_APP_SLUG &&
      process.env.RUNTIME_WRITE_TOKEN,
    "Runtime updater App identity is not configured.",
  );
  const task = validateTask(parseJson(process.env.TASK_JSON));
  invariant(
    task.automation === context.head &&
      Date.now() - Date.parse(task.createdAt) < 2 * 86_400_000,
    "Preparation task is stale or belongs to another automation commit.",
  );
  const reader = new GitHub(),
    run = await reader.get(`/actions/runs/${context.id}`);
  validateRun(run, {
    ...context,
    workflow: "agent-runtime-radar.yml",
    events: ["schedule", "workflow_dispatch"],
  });
  invariant(
    run.workflow_id ===
      (await reader.get("/actions/workflows/agent-runtime-radar.yml")).id,
    "Writer workflow identity mismatch.",
  );
  const prepared = validatePrepared(
    await readArtifact(
      reader,
      run,
      `agent-runtime-prepared-${task.provider}-${context.id}-${context.attempt}`,
      "prepared.json",
      LIMITS.patch + LIMITS.report,
    ),
    task,
    context,
  );
  const result = await writePreparedProposal({
    github: new GitHub({ token: process.env.RUNTIME_WRITE_TOKEN }),
    task,
    prepared,
    appSlug: process.env.RUNTIME_APP_SLUG,
  });
  writeFileSync(
    process.env.RESULT_PATH,
    `${JSON.stringify({ schema: 1, runId: context.id, attempt: context.attempt, result })}\n`,
  );
  console.log(`Runtime writer: ${task.provider} ${result.status}.`);
}

main().catch(() => {
  console.error(
    "Runtime writer stopped. No reset or force push was attempted; inspect trusted run evidence and retry after reconciliation.",
  );
  process.exitCode = 1;
});
