import type { ReassignCandidate } from "../../platform/team-sharing";

/** No-Creator bar (owner decision 2026-11-13): in place of the composer while a workspace has no Creator. Only a document
 * that negotiated team ownership can say so; the server's canReassign names who may act on it. */
export function noCreatorBarKind(doc: { ownerUserId?: string | null; sharing?: { ownership?: { canReassign: boolean } } } | undefined): "admin" | "member" | null {
  const ownership = doc?.sharing?.ownership;
  if (!ownership || doc?.ownerUserId !== null) return null;
  return ownership.canReassign ? "admin" : "member";
}

const REASONS = {
  on_hold: "You're on hold in this organization, so you can't be the Creator.",
  repository_access_required: "You need access to this workspace's repository to be its Creator.",
  account_inactive: "Your account is inactive, so you can't be the Creator.",
} as const;

export type SelfCreatorEligibility = { state: "pending" } | { state: "eligible" } | { state: "ineligible"; reason: string } | { state: "unknown" };

/** The caller's own candidate row decides "Make me the Creator". Not answered yet: pending. A failed read, no viewer, or
 * a server that does not list the caller: unknown, so only Reassign… is offered. */
export function selfCreatorEligibility(candidates: readonly ReassignCandidate[] | null | undefined, me: string | null): SelfCreatorEligibility {
  if (candidates === undefined) return { state: "pending" };
  const own = me && candidates ? candidates.find(candidate => candidate.userId === me) : undefined;
  if (!own) return { state: "unknown" };
  return own.eligible ? { state: "eligible" } : { state: "ineligible", reason: REASONS[own.reason] };
}

export function makeMeCreatorConfirmCopy(workspace: string) {
  return { title: `Make yourself the Creator of ${workspace}?`,
    body: "Your agent logins will run every turn here, and commits will carry your Git identity." };
}
