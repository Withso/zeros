import type { RuntimeUpdateHandlers } from "./runtime-update-runner.js";
import type { CloudRuntimeActivationPolicy, CloudRuntimeTransitionClaim, CloudRuntimeTransferEnrollment,
  DatabaseCloudRuntimeTransitionService } from "./runtime-transfer.js";

type EnrollmentContext = Parameters<RuntimeUpdateHandlers["enroll"]>[0];
type HealthContext = Parameters<RuntimeUpdateHandlers["health"]>[0];
type HealthObservation = Awaited<ReturnType<Parameters<DatabaseCloudRuntimeTransitionService["verifyHealth"]>[1]>>;

/** Compose the fixed root conversation with durable service commits. The
 * caller supplies bounded launch material and a fresh pinned-root health
 * probe, and persists service.finish only after the runner's final receipt.
 * This adapter does not select an activation policy or enable a worker. */
export function createResidentRuntimeUpdateHandlers(options: {
  service: DatabaseCloudRuntimeTransitionService;
  claim: CloudRuntimeTransitionClaim;
  policy: CloudRuntimeActivationPolicy;
  environment(enrollment: CloudRuntimeTransferEnrollment, context: EnrollmentContext): Promise<Record<string, unknown> | null>;
  probeHealth(challenge: string, context: HealthContext): Promise<HealthObservation>;
}): RuntimeUpdateHandlers {
  const { service, claim } = options;
  const owns = ({ input }: Parameters<RuntimeUpdateHandlers["authorize"]>[0]) =>
    input.operation === "activate" && !!input.handoff && input.transitionId === claim.transitionId && input.fence === claim.executionFence &&
    input.scope.workspaceId === claim.workspaceId && input.scope.organizationId === claim.organizationId;
  return {
    async authorize() { return false; },
    async authorizeConsumption(context) {
      if (!owns(context) || context.input.operation !== "activate" || !context.input.handoff || !context.controller) return false;
      return service.authorizeResidentConsumption(claim, { controller: context.controller, policy: options.policy,
        handoff: context.input.handoff, receipt: context.receipt, resident: context.resident });
    },
    async consumed(context) {
      if (!owns(context) || context.input.operation !== "activate" || !context.input.handoff) return false;
      return await service.recordResidentConsumption(claim, { handoff: context.input.handoff, resident: context.resident }) &&
        await service.retireResidentSource(claim);
    },
    async cancelConsumption(context) {
      if (!owns(context) || context.input.operation !== "activate" || !context.input.handoff) return false;
      return service.cancelResidentConsumption(claim, { handoff: context.input.handoff, resident: context.resident });
    },
    async authorizeRollback(context) { return owns(context) && await service.beginRollback(claim); },
    async enroll(context) {
      if (!owns(context) || !context.controller || !context.resident) return null;
      const enrollment = await service.enroll(claim, { active: context.active, controller: context.controller,
        report: context.report, rollback: context.rollback, resident: context.resident });
      return enrollment ? options.environment(enrollment, context) : null;
    },
    async health(context) {
      return owns(context) && !!context.resident && await service.verifyHealth(claim, async challenge => {
        const observation = await options.probeHealth(challenge, context);
        // Both observations come from the authenticated root channel, but the
        // fresh challenge must attest the same attachment as this conversation.
        if (!observation.resident || Object.entries(context.resident!).some(([key, value]) =>
          observation.resident![key as keyof typeof observation.resident] !== value)) throw new Error("Runtime health rejected");
        return observation;
      });
    },
  };
}
