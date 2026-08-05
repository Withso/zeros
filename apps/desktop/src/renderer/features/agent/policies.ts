// ──────────────────────────────────────────────────────────
// Per-chat permission policies — "Always for X" decisions
// ──────────────────────────────────────────────────────────
//
// When the user picks "Always allow" / "Always block"
// on the inline permission cluster, we record a Zeros-side policy
// keyed by chatId. Future permission requests in the same chat
// are matched against the policy list FIRST; on hit we auto-
// respond through the bridge and never bother the user with a
// prompt — the engine still receives a normal selected-option
// response, so its own policy machinery stays in sync.
//
// Policies are deliberately per-chat (not session, not global).
// The chat is the unit of conversation context; a "yes always"
// decision in one chat shouldn't silently apply to a fresh chat the next day.
//
// Persistence: localStorage (device-local). It gives the synchronous-boot
// bootstrap the store needs at module load. Policies are a per-device
// convenience; persistence stays isolated to this module and the store mutators.
// ──────────────────────────────────────────────────────────

const STORAGE_KEY = "zeros.chat-policies.v1";

export type PolicyDecision = "allow" | "reject";

export interface PolicyRule {
  /** Stable id so the user can revoke a specific rule from
   *  Settings / from the chip on the tool card. */
  id: string;
  /** The chat this rule belongs to. */
  chatId: string;
  /** Match rule. Empty toolKind matches anything; toolTitle
   *  is the exact title (e.g. "Bash") or a prefix the rule
   *  cares about. Current rules match on toolKind; toolTitle remains optional. */
  toolKind?: string;
  toolTitle?: string;
  /** allow → respond with the request's allow_always option;
   *  reject → respond with reject_always. */
  decision: PolicyDecision;
  /** Wall-clock milliseconds for ordering and stale-rule inspection. */
  createdAt: number;
}

interface PolicyDoc {
  /** Map of chatId → list of rules. */
  byChat: Record<string, PolicyRule[]>;
}

const EMPTY: PolicyDoc = { byChat: {} };

/** Read policies from localStorage. Tolerant to missing / malformed
 *  data — returns an empty doc rather than throwing. */
export function loadPolicies(): PolicyDoc {
  if (typeof window === "undefined") return EMPTY;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as PolicyDoc;
    if (!parsed || typeof parsed !== "object" || !parsed.byChat) return EMPTY;
    return parsed;
  } catch {
    return EMPTY;
  }
}

/** Persist a policy doc back to localStorage. Best-effort —
 *  swallows quota errors etc. and logs to console only. */
export function savePolicies(doc: PolicyDoc): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  } catch (err) {
    console.warn("[Zeros policies] persist failed:", err);
  }
}

/** Find the first policy matching the given tool. Returns null
 *  if nothing applies, in which case the UI shows the prompt. */
export function findMatchingPolicy(
  rules: PolicyRule[],
  toolKind: string | undefined,
  toolTitle: string | undefined,
): PolicyRule | null {
  for (const r of rules) {
    if (r.toolKind && r.toolKind !== toolKind) continue;
    if (r.toolTitle && r.toolTitle !== toolTitle) continue;
    return r;
  }
  return null;
}

/** Build a fresh policy id. Date-based + random suffix — collisions
 *  inside a single chat are vanishingly unlikely. */
export function newPolicyId(): string {
  return `pol-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
