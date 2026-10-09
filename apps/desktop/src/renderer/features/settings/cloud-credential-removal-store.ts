import { z } from "zod";
import { cloudCredentialRemovalOutcomeSchema, cloudCredentialRemovalTargetSchema,
  type CloudCredentialRemovalState, type CloudCredentialRemovalTarget } from "./cloud-credential-removal";

// Preserve the Settings key namespace, but use strict durable IO. Preference
// readers intentionally substitute defaults on failure; mutation identities
// must distinguish an absent entry from an unreadable prior submitted Yes.
const KEY = "zeros-cloud-credential-removal:intents:v1";
const MAX_INTENTS = 64;
const uuid = z.string().uuid();
const revision = z.number().int().safe().positive();
const savedState = z.object({
  operationId: uuid,
  target: cloudCredentialRemovalTargetSchema,
  outcome: cloudCredentialRemovalOutcomeSchema.optional(),
  decision: z.object({ action: z.enum(["confirm", "cancel"]), requestId: uuid, expectedRevision: revision }).strict().optional(),
}).strict().refine(value => !value.outcome || value.outcome.operationId === value.operationId);
const savedEntries = z.array(z.object({ version: z.literal(1), userId: uuid, state: savedState }).strict()).max(MAX_INTENTS)
  .refine(values => new Set(values.map(value => JSON.stringify([value.userId, value.state.operationId]))).size === values.length);
type SavedEntry = z.infer<typeof savedEntries>[number];

function entries(): SavedEntry[] {
  let value: unknown;
  try {
    const raw = localStorage.getItem(KEY);
    value = raw === null ? [] : JSON.parse(raw);
  } catch { throw new Error("Saved cloud removal state is unavailable"); }
  const parsed = savedEntries.safeParse(value);
  // Corrupt persisted state is not evidence that an unknown-ACK operation never
  // existed. Refuse creating another mutation identity from that assumption.
  if (!parsed.success) throw new Error("Saved cloud removal state is unavailable");
  return parsed.data;
}
const terminal = (state: CloudCredentialRemovalState) => !!state.outcome && ["removed", "cancelled", "expired"].includes(state.outcome.state);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function frozen(value: z.infer<typeof savedState>): CloudCredentialRemovalState {
  return Object.freeze({ operationId: value.operationId, target: Object.freeze(value.target),
    ...(value.outcome ? { outcome: Object.freeze(value.outcome) } : {}),
    ...(value.decision ? { decision: Object.freeze(value.decision) } : {}) });
}

/** Nonsecret durable reconciliation identity only; this grants no authority.
 * Current account authentication still fences every remote request. */
export function readCloudCredentialRemovalIntent(userId: string, operationId: string): CloudCredentialRemovalState | undefined {
  uuid.parse(userId); uuid.parse(operationId);
  const value = entries().find(row => row.userId === userId && row.state.operationId === operationId)?.state;
  return value ? frozen(value) : undefined;
}
export function findCloudCredentialRemovalIntent(userId: string, target: CloudCredentialRemovalTarget): CloudCredentialRemovalState | undefined {
  uuid.parse(userId);
  const parsed = cloudCredentialRemovalTargetSchema.parse(target);
  const value = entries().reverse().find(row => row.userId === userId && same(row.state.target, parsed) && !terminal(row.state))?.state;
  return value ? frozen(value) : undefined;
}

/** Call before prepare and before submitting Yes/No. Read back the exact
 * identity so a dropped preference write cannot lose the only safe retry key. */
export function persistCloudCredentialRemovalIntent(userId: string, supplied: CloudCredentialRemovalState): void {
  uuid.parse(userId);
  const state = savedState.parse(supplied);
  const current = entries();
  const prior = current.find(row => row.userId === userId && row.state.operationId === state.operationId)?.state;
  if (prior && (!same(prior.target, state.target) || (prior.decision && !same(prior.decision, state.decision)) ||
      (prior.outcome && (!state.outcome || state.outcome.revision < prior.outcome.revision ||
        (state.outcome.revision === prior.outcome.revision && !same(prior.outcome, state.outcome)))) ||
      (terminal(prior) && !same(prior.outcome, state.outcome))))
    throw new Error("Cloud removal identity changed");
  const retained = current.filter(row => row.userId !== userId || row.state.operationId !== state.operationId);
  while (retained.length >= MAX_INTENTS) {
    const index = retained.findIndex(row => terminal(row.state));
    if (index < 0) throw new Error("Too many cloud removals are pending");
    retained.splice(index, 1);
  }
  const next = [...retained, { version: 1 as const, userId, state }];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
    if (!same(entries(), next)) throw new Error("Cloud removal state could not be saved");
  } catch { throw new Error("Cloud removal state could not be saved"); }
}
