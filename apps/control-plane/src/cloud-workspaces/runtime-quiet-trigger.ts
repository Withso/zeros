import { randomUUID } from "node:crypto";
import { withSystemTx, type Tx } from "../db.js";
import { lockCloudWorkspaceGenerationTransition } from "./generation-transitions.js";
import { cloudWorkspaceHasActiveWork } from "./idle-workloads.js";
import {
  DatabaseCloudRuntimeTransitionService,
  type CloudRuntimeActivationPolicy,
  type CloudRuntimeTransitionClaim,
} from "./runtime-transfer.js";
import {
  CloudRuntimeQuietSnapshotSchema,
  type CloudRuntimeQuietSnapshot,
  type CloudRuntimeQuietScope,
} from "./runtime-quiet-contract.js";

const PROBE_TIMEOUT_MS = 2_000;
export type CloudRuntimeQuietReader = (
  input: CloudRuntimeQuietScope & { challenge: string; signal: AbortSignal },
) => Promise<unknown>;
export interface CloudRuntimeQuietPolicy {
  readonly id: string;
  accepts(snapshot: CloudRuntimeQuietSnapshot): boolean;
}
/** No measured gap yet: a present client or any unknown signal defers. LU may
 * provide a separately qualified safe-point policy without changing transfer. */
export const cloudRuntimeQuietAbsentPolicy: CloudRuntimeQuietPolicy =
  Object.freeze({
    id: "zeros_quiet_absent_v1",
    accepts: (snapshot: CloudRuntimeQuietSnapshot) =>
      snapshot.stable &&
      snapshot.recordSync === "ready" &&
      snapshot.quietForMs >= 60_000 &&
      !snapshot.workloadBusy &&
      !snapshot.livePty &&
      snapshot.userProcesses === "idle" &&
      snapshot.presence === "absent",
  });

/** The reader is a trusted pinned-root controller adapter, never a client
 * route, cached heartbeat or arbitrary engine URL. The adapter bounds bytes,
 * authenticates the exact source and honors cancellation. Exceptions and raw
 * payloads do not become diagnostics. A nonce alone is not authentication. */
export async function readFreshCloudRuntimeQuietSnapshot(
  read: CloudRuntimeQuietReader,
  scope: CloudRuntimeQuietScope,
  now: () => number = () => performance.now(),
): Promise<{ snapshot: CloudRuntimeQuietSnapshot; startedAt: number } | null> {
  const challenge = randomUUID(),
    startedAt = now(),
    controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(null);
      }, PROBE_TIMEOUT_MS);
      timer.unref?.();
    });
    const raw = await Promise.race([
      Promise.resolve().then(() =>
        read({ ...scope, challenge, signal: controller.signal }),
      ),
      timeout,
    ]);
    const parsed = CloudRuntimeQuietSnapshotSchema.safeParse(raw);
    if (
      !parsed.success ||
      controller.signal.aborted ||
      now() - startedAt > PROBE_TIMEOUT_MS ||
      now() < startedAt
    )
      return null;
    const snapshot = parsed.data;
    if (
      snapshot.challenge !== challenge ||
      snapshot.workspaceId !== scope.workspaceId ||
      snapshot.organizationId !== scope.organizationId ||
      snapshot.generation !== scope.generation ||
      snapshot.engineInstanceId !== scope.engineInstanceId
    )
      return null;
    return { snapshot, startedAt };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** Callable from the lifecycle scheduler/controller: it owns neither a poll
 * interval nor VM admission. A production activation caller must combine the
 * returned observation policy with LU's local safe-point/attach fence. */
export class DatabaseCloudRuntimeQuietTrigger {
  private readonly policy: CloudRuntimeQuietPolicy;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      service: DatabaseCloudRuntimeTransitionService;
      readQuiet: CloudRuntimeQuietReader;
      policy?: CloudRuntimeQuietPolicy;
      now?: () => number;
    },
  ) {
    this.policy = options.policy ?? cloudRuntimeQuietAbsentPolicy;
    this.now = options.now ?? (() => performance.now());
  }

  async consider(input: {
    workspaceId: string;
    organizationId: string;
    generation: number;
    sourceEngineInstanceId: string;
    mode: "engine" | "bootstrap";
  }) {
    const scope = {
      workspaceId: input.workspaceId,
      organizationId: input.organizationId,
      generation: input.generation,
      engineInstanceId: input.sourceEngineInstanceId,
    };
    const idle = await withSystemTx(
      this.options.service.options.pool,
      async (tx) => {
        await lockCloudWorkspaceGenerationTransition(tx, scope);
        return !(await cloudWorkspaceHasActiveWork(tx, scope));
      },
    );
    if (!idle) return null;
    const evidence = await readFreshCloudRuntimeQuietSnapshot(
      this.options.readQuiet,
      scope,
      this.now,
    );
    if (!evidence || !this.policy.accepts(evidence.snapshot)) return null;
    // An offer only stages beside the source. Work can start immediately after
    // this read; activate always requires its own fresh, locked policy check.
    // RU's selector, qualification and single-transition lock live in offer.
    return this.options.service.offer({ ...input, operationId: randomUUID() });
  }

  async prepareActivation(
    claim: CloudRuntimeTransitionClaim,
  ): Promise<CloudRuntimeActivationPolicy | null> {
    const scope = await withSystemTx(
      this.options.service.options.pool,
      async (tx) => {
        await lockCloudWorkspaceGenerationTransition(tx, claim);
        const source = await this.source(tx, claim);
        return source && !(await cloudWorkspaceHasActiveWork(tx, source))
          ? source
          : null;
      },
    );
    if (!scope) return null;
    const prepared = await readFreshCloudRuntimeQuietSnapshot(
      this.options.readQuiet,
      scope,
      this.now,
    );
    if (!prepared || !this.policy.accepts(prepared.snapshot)) return null;
    const expected = { ...claim };
    return {
      id: this.policy.id,
      authorize: async (tx, current) => {
        if (
          Object.entries(expected).some(
            ([key, value]) =>
              current[key as keyof CloudRuntimeTransitionClaim] !== value,
          )
        )
          return false;
        const source = await this.source(tx, current);
        if (
          !source ||
          source.engineInstanceId !== scope.engineInstanceId ||
          source.generation !== scope.generation ||
          (await cloudWorkspaceHasActiveWork(tx, source))
        )
          return false;
        const fresh = await readFreshCloudRuntimeQuietSnapshot(
          this.options.readQuiet,
          scope,
          this.now,
        );
        if (
          !fresh ||
          fresh.snapshot.activityRevision !==
            prepared.snapshot.activityRevision ||
          !this.policy.accepts(fresh.snapshot)
        )
          return false;
        // This runs under activate's shared organization/workspace ownership
        // lock. Recheck server work and elapsed time after awaited VM evidence.
        return (
          !(await cloudWorkspaceHasActiveWork(tx, source)) &&
          this.now() - fresh.startedAt <= PROBE_TIMEOUT_MS
        );
      },
    };
  }

  private async source(
    tx: Tx,
    claim: CloudRuntimeTransitionClaim,
  ): Promise<CloudRuntimeQuietScope | null> {
    const result = await tx.query<CloudRuntimeQuietScope>(
      `SELECT runtime.workspace_id AS "workspaceId",runtime.org_id AS "organizationId",
      transition.source_generation AS generation,runtime.source_engine_instance_id AS "engineInstanceId"
      FROM cloud_workspace_runtime_transitions runtime
      JOIN cloud_workspace_generation_transitions transition ON transition.id=runtime.transition_id
      JOIN cloud_workspaces workspace ON workspace.id=runtime.workspace_id AND workspace.org_id=runtime.org_id
      JOIN cloud_workspace_engine_instances engine ON engine.id=runtime.source_engine_instance_id
        AND engine.workspace_id=runtime.workspace_id AND engine.org_id=runtime.org_id AND engine.generation=transition.source_generation
      WHERE runtime.transition_id=$1 AND runtime.workspace_id=$2 AND runtime.org_id=$3
        AND runtime.worker_id=$4 AND runtime.worker_fence=$5 AND runtime.execution_fence=$6
        AND runtime.worker_expires_at>clock_timestamp() AND runtime.stage_deadline_at>clock_timestamp()
        AND runtime.phase='staged' AND transition.execution_mode='retain_allocation' AND transition.state='draining'
        AND workspace.current_generation=transition.source_generation AND workspace.deleted_at IS NULL
        AND workspace.desired_state='running' AND workspace.status IN ('ready','busy')
        AND engine.state='ready' AND engine.lease_expires_at>clock_timestamp()`,
      [
        claim.transitionId,
        claim.workspaceId,
        claim.organizationId,
        claim.workerId,
        claim.workerFence,
        claim.executionFence,
      ],
    );
    return result.rows[0] ?? null;
  }
}
