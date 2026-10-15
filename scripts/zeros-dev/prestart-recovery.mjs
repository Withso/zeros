// Owner-reviewed incident record, shipped with the startup repair. The exact
// immutable source failed its tsx module transform before the entrypoint body
// could initialize the product client. This is not an error-text rule,
// reset flag, empty-receipt fabrication or permission to cross another failure.
export const PRESTART_RECOVERY = Object.freeze({
  version: 1,
  workflowRunId: "38682977049",
  attempt: 1,
  sourceSha: "bb8455571cb27026060ad728f245e700151fdf38",
  jobId: "116251429975",
  cause: "module_transform_before_evaluation",
});

export function reviewedPrestartRecovery(run, job) {
  if (String(run.id) !== PRESTART_RECOVERY.workflowRunId || run.run_attempt !== PRESTART_RECOVERY.attempt ||
    run.head_sha !== PRESTART_RECOVERY.sourceSha || run.event !== "workflow_dispatch" || run.status !== "completed" ||
    run.conclusion !== "failure" || String(job.id) !== PRESTART_RECOVERY.jobId || job.name !== "gate0" ||
    job.status !== "completed" || job.conclusion !== "failure" || job.run_attempt !== PRESTART_RECOVERY.attempt ||
    !["Execute Alpha product lifecycle", "Save signed cleanup receipt"].every(name => {
      const steps = job.steps.filter(step => step.name === name);
      return steps.length === 1 && steps[0].status === "completed" && steps[0].conclusion === "failure";
    })) return null;
  return { ...PRESTART_RECOVERY };
}
