import { isDeepStrictEqual } from "node:util";
import { isCloudAuthorizedActor, type CloudAuthorizedActor, type CloudActorAuthorityRegistry } from "./cloud-actor-authority";
import { isCloudAcceptedWork, type CloudAcceptedWork } from "./cloud-accepted-work-authority";

/** Accepted work stays a distinct genuine principal. These projections expose
 * identity only; they never mint actor provenance or renew a client session. */
export type CloudExecutionPrincipal = CloudAuthorizedActor | CloudAcceptedWork;
export function cloudExecutionPrincipalScope(value: CloudExecutionPrincipal) {
  if (isCloudAcceptedWork(value)) return value.receipt.scope;
  if (isCloudAuthorizedActor(value)) return value.provenance.scope;
  throw new Error("cloud_actor_authority_rejected");
}
export function cloudExecutionPrincipalActor(value: CloudExecutionPrincipal) {
  if (isCloudAcceptedWork(value)) return value.receipt.actor;
  if (isCloudAuthorizedActor(value)) return value.provenance.actor;
  throw new Error("cloud_actor_authority_rejected");
}
export function cloudExecutionPrincipalSession(value: CloudExecutionPrincipal): string {
  if (isCloudAcceptedWork(value)) return value.receipt.actorSessionId;
  if (isCloudAuthorizedActor(value)) return value.provenance.actorSessionId;
  throw new Error("cloud_actor_authority_rejected");
}
export function assertCloudExecutionPrincipal(value: CloudExecutionPrincipal, registry: CloudActorAuthorityRegistry): void {
  if (isCloudAcceptedWork(value)) {
    if (!isDeepStrictEqual(value.receipt.scope, registry.scope)) throw new Error("accepted_work_rejected");
    value.assertLive();
  } else registry.assertActor(value, "run");
}
