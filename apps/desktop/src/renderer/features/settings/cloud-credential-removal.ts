import { z } from "zod";
import { cloudAccountRequest } from "../../platform/cloud-workspaces";

const uuid = z.string().uuid();
const revision = z.number().int().safe().positive();
export const cloudCredentialRemovalTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("remove-organization-credential"), organizationId: uuid, credentialId: uuid, expectedCredentialRevision: revision }).strict(),
  z.object({ kind: z.literal("revoke-credential"), credentialId: uuid, expectedCredentialRevision: revision }).strict(),
  z.object({ kind: z.literal("disconnect-provider"), organizationId: uuid, provider: z.enum(["claude", "codex", "cursor"]), expectedConnectionRevision: revision }).strict(),
  z.object({ kind: z.literal("remove-dev-reference"), organizationId: uuid, referenceId: uuid, scope: z.enum(["local", "organization", "global"]), expectedCredentialRevision: revision }).strict(),
]);
export type CloudCredentialRemovalTarget = z.infer<typeof cloudCredentialRemovalTargetSchema>;
const base = { version: z.literal(1), operationId: uuid, revision };
export const cloudCredentialRemovalOutcomeSchema = z.discriminatedUnion("state", [
  z.object({ ...base, state: z.literal("removed") }).strict(),
  z.object({ ...base, state: z.literal("cancelled") }).strict(),
  z.object({ ...base, state: z.literal("expired") }).strict(),
  z.object({ ...base, state: z.literal("awaiting-confirmation"), expiresAt: z.string().datetime(), confirmedRunning: z.literal(true) }).strict(),
  z.object({ ...base, state: z.literal("pending"), phase: z.enum(["preparing", "removing", "cancelling"]), retryAfterMs: z.number().int().min(100).max(30000) }).strict(),
]);
export type CloudCredentialRemovalOutcome = z.infer<typeof cloudCredentialRemovalOutcomeSchema>;
const path = "/v1/cloud-agent-credentials/removals";
const exactOutcome = (operationId: string) => cloudCredentialRemovalOutcomeSchema.refine(value => value.operationId === operationId, "Removal operation changed");
export function prepareCloudCredentialRemoval(operationId: string, target: CloudCredentialRemovalTarget) {
  const body = z.object({ version: z.literal(1), operationId: uuid, target: cloudCredentialRemovalTargetSchema }).strict().parse({ version: 1, operationId, target });
  return cloudAccountRequest(`${path}/prepare`, exactOutcome(operationId), { body, idempotencyKey: operationId });
}
export function readCloudCredentialRemoval(operationId: string) {
  return cloudAccountRequest(`${path}/${uuid.parse(operationId)}`, exactOutcome(operationId));
}
export function decideCloudCredentialRemoval(operationId: string, action: "confirm" | "cancel", input: { requestId: string; expectedRevision: number }) {
  const body = z.object({ version: z.literal(1), requestId: uuid, expectedRevision: revision }).strict().parse({ version: 1, ...input });
  return cloudAccountRequest(`${path}/${uuid.parse(operationId)}/${z.enum(["confirm", "cancel"]).parse(action)}`, exactOutcome(operationId), { body, idempotencyKey: input.requestId });
}

export interface CloudCredentialRemovalState {
  readonly operationId: string;
  readonly target: CloudCredentialRemovalTarget;
  readonly outcome?: CloudCredentialRemovalOutcome;
  /** Persist BEFORE sending; submitted/unknown Yes can never trigger cleanup cancel. */
  readonly decision?: { readonly action: "confirm" | "cancel"; readonly requestId: string; readonly expectedRevision: number };
}
export function beginCloudCredentialRemoval(operationId: string, target: CloudCredentialRemovalTarget): CloudCredentialRemovalState {
  return Object.freeze({ operationId: uuid.parse(operationId), target: Object.freeze(cloudCredentialRemovalTargetSchema.parse(target)) });
}
export function acceptCloudCredentialRemovalOutcome(state: CloudCredentialRemovalState, incoming: unknown): CloudCredentialRemovalState {
  const outcome = exactOutcome(state.operationId).parse(incoming);
  if (state.outcome && outcome.revision < state.outcome.revision) return state;
  if (state.outcome && ["removed", "cancelled", "expired"].includes(state.outcome.state)) {
    if (JSON.stringify(state.outcome) !== JSON.stringify(outcome)) throw new Error("Removal terminal outcome changed");
    return state;
  }
  if (state.outcome && outcome.revision === state.outcome.revision && JSON.stringify(outcome) !== JSON.stringify(state.outcome))
    throw new Error("Removal revision changed");
  if (state.outcome?.state === "pending" && state.outcome.phase !== "preparing") {
    const won = state.outcome.phase;
    const unchanged = outcome.state === "pending" && outcome.phase === won;
    const terminal = won === "removing" ? outcome.state === "removed" : outcome.state === "cancelled" || outcome.state === "expired";
    if (!unchanged && !terminal) throw new Error("Removal decision changed");
  }
  return Object.freeze({ ...state, outcome: Object.freeze(outcome) });
}
export function cloudCredentialRemovalNeedsConfirmation(state: CloudCredentialRemovalState): boolean {
  return !state.decision && state.outcome?.state === "awaiting-confirmation" && state.outcome.confirmedRunning;
}
export function decideCloudCredentialRemovalState(state: CloudCredentialRemovalState, action: "confirm" | "cancel", requestId: string): CloudCredentialRemovalState {
  if (state.decision) return state;
  if (!state.outcome || ["removed", "cancelled", "expired"].includes(state.outcome.state) ||
      (state.outcome.state === "pending" && state.outcome.phase !== "preparing")) return state;
  if (action === "confirm" && !cloudCredentialRemovalNeedsConfirmation(state)) return state;
  return Object.freeze({ ...state, decision: Object.freeze({ action, requestId: uuid.parse(requestId), expectedRevision: state.outcome.revision }) });
}
/** Unmount may only cancel an undecided, unconfirmed operation. It cannot
 * change a submitted Yes even when the request's reply never arrived. */
export function leaveCloudCredentialRemoval(state: CloudCredentialRemovalState, requestId: string): CloudCredentialRemovalState {
  return decideCloudCredentialRemovalState(state, "cancel", requestId);
}
