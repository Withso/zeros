import type pg from "pg";
import { claimJobs, completeJob } from "../job-queue.js";
import { LIFECYCLE_JOB_KINDS, type LifecycleWork } from "./lifecycle-jobs.js";
import type { CloudWorkspaceReconciler } from "./reconciler.js";

/** Run due lifecycle jobs the way a runner does, without its timers, until
 * none is due (bounded). Returns the number of job runs. */
export async function runDueLifecycleJobs(
  pool: pg.Pool,
  reconciler: Pick<CloudWorkspaceReconciler, "runJob">,
  works: readonly LifecycleWork[] = Object.keys(LIFECYCLE_JOB_KINDS) as LifecycleWork[],
): Promise<number> {
  let runs = 0;
  for (let round = 0; round < 10; round++) {
    const { jobs } = await claimJobs(pool, {
      owner: "lifecycle-test",
      limit: 100,
      kinds: works.map(work => ({ kind: LIFECYCLE_JOB_KINDS[work], leaseMs: 60_000 })),
    });
    if (!jobs.length) return runs;
    for (const job of jobs) {
      await reconciler.runJob(job);
      await completeJob(pool, job);
      runs += 1;
    }
  }
  return runs;
}
