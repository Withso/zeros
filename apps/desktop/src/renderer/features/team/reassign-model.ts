import type { ReassignCandidate } from "../../platform/team-sharing";

/** Team sharing 3B: the Reassign dialog's words and choices, kept apart from its view so each state is tested. */
const AGENTS = [["claude", "Claude"], ["codex", "Codex"], ["cursor", "Cursor"]] as const;
const REASONS = { on_hold: "On hold", account_inactive: "Account inactive", repository_access_required: "No repository access" } as const;

export interface ReassignRow { userId: string; name: string; eligible: boolean; hint: string | null }

/** Eligible people first, then the rest, each by name. An eligible person's missing agent logins are a hint only (Creator pays). */
export function reassignCandidateRows(candidates: readonly ReassignCandidate[], roster: readonly { id: string; name: string }[] | null): ReassignRow[] {
  const name = (userId: string) => roster?.find(member => member.id === userId)?.name ?? "Former member";
  return candidates.map(candidate => {
    if (!candidate.eligible) return { userId: candidate.userId, name: name(candidate.userId), eligible: false, hint: REASONS[candidate.reason] };
    const logins = candidate.agentLogins;
    const missing = logins ? AGENTS.filter(([id]) => !logins[id]).map(([, label]) => label) : [];
    const hint = !logins || !missing.length ? null : missing.length === AGENTS.length ? "No agent login" : `No ${missing.join(" or ")} login`;
    return { userId: candidate.userId, name: name(candidate.userId), eligible: true, hint };
  }).sort((a, b) => Number(b.eligible) - Number(a.eligible) || a.name.localeCompare(b.name));
}

/** creator: "you" when the caller is the current Creator, their name otherwise, null when there is none. */
export function reassignConfirmCopy(input: { workspace: string; to: string; caller: "creator" | "admin"; creator: string | null }) {
  return {
    title: `Make ${input.to} the Creator of ${input.workspace}?`,
    body: `${input.to}'s agent logins will run every turn here.`,
    follow: input.caller === "creator" ? "You'll keep following it." : input.creator ? `${input.creator} will keep following it.` : null,
  };
}

export function reassignErrorMessage(code: string, to?: string): string {
  switch (code) {
    case "creator_changed": return "Someone else changed the Creator. The list is up to date now.";
    case "assignee_ineligible": return `${to ?? "This person"} can't be the Creator of this workspace.`;
    case "github_verification_unavailable": return "Can't check repository access right now. Try again.";
    case "rate_limited": return "Too many changes. Try again shortly.";
    default: return "The Creator couldn't be changed. Try again.";
  }
}

/** One request id per choice: a retry of the same choice replays it; another choice (or a cleared one after a conflict) gets a new id. */
export function reassignNextRequestId(held: { requestId: string; toUserId: string } | undefined, toUserId: string, make: () => string = () => crypto.randomUUID()) {
  return held && held.toUserId === toUserId ? held : { requestId: make(), toUserId };
}
