import { acceptCloudCredentialRemovalOutcome, beginCloudCredentialRemoval, decideCloudCredentialRemovalState,
  prepareCloudCredentialRemoval, readCloudCredentialRemoval, decideCloudCredentialRemoval,
  type CloudCredentialRemovalState, type CloudCredentialRemovalTarget, type CloudCredentialRemovalOutcome } from "./cloud-credential-removal";
import { findCloudCredentialRemovalIntent, persistCloudCredentialRemovalIntent } from "./cloud-credential-removal-store";

export interface CloudCredentialRemovalIo {
  prepare(operationId: string, target: CloudCredentialRemovalTarget): Promise<CloudCredentialRemovalOutcome>;
  read(operationId: string): Promise<CloudCredentialRemovalOutcome>;
  decide(operationId: string, action: "confirm" | "cancel", input: { requestId: string; expectedRevision: number }): Promise<CloudCredentialRemovalOutcome>;
}
export interface CloudCredentialRemovalSnapshot {
  readonly state?: CloudCredentialRemovalState;
  readonly busy: boolean;
  readonly error?: string;
}
const terminal = (state?: CloudCredentialRemovalState) => !!state?.outcome && ["removed", "cancelled", "expired"].includes(state.outcome.state);
const acknowledged = (state?: CloudCredentialRemovalState) => terminal(state) || state?.outcome?.state === "pending" && state.outcome.phase !== "preparing";
const defaultIo: CloudCredentialRemovalIo = { prepare: prepareCloudCredentialRemoval, read: readCloudCredentialRemoval, decide: decideCloudCredentialRemoval };

/** One account-owned explicit Settings operation. Persist before submission;
 * retries carry the same operation/decision IDs through unknown acknowledgements.
 * Unmount stops observations and can cancel only an unsubmitted decision. */
export function createCloudCredentialRemovalController(options: {
  userId: string;
  isCurrent(): boolean;
  onRemoved?(target: CloudCredentialRemovalTarget): void | Promise<void>;
  io?: CloudCredentialRemovalIo;
  uuid?: () => string;
}) {
  const io = options.io ?? defaultIo, uuid = options.uuid ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let snapshot: CloudCredentialRemovalSnapshot = Object.freeze({ busy: false });
  let flight: Promise<void> | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  let attached = true, decisionAcknowledged = false, removedPublished = false;
  const publish = (next: CloudCredentialRemovalSnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const save = (state: CloudCredentialRemovalState) => {
    persistCloudCredentialRemovalIntent(options.userId, state);
    publish({ state, busy: snapshot.busy });
  };
  const stopTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stopTimer();
    const state = snapshot.state;
    if (!attached || !options.isCurrent() || !state || terminal(state) ||
        (!snapshot.error && state.outcome?.state === "awaiting-confirmation" && !state.decision)) return;
    const delay = state.outcome?.state === "pending" ? state.outcome.retryAfterMs : 1500;
    timer = setTimeout(() => { timer = undefined; void pump(); }, delay);
  };
  function pump(): Promise<void> {
    if (flight) return flight;
    if (!options.isCurrent() || !snapshot.state || terminal(snapshot.state)) return Promise.resolve();
    const original = snapshot.state;
    publish({ state: original, busy: true });
    // Install the flight before invoking an IO boundary: even a synchronous
    // validation refusal must clear the same flight and remain retryable.
    let finish!: () => void, fail!: (error: unknown) => void;
    const running = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
    flight = running;
    const task = (async () => {
      try {
        const incoming = original.decision && !decisionAcknowledged
          ? await io.decide(original.operationId, original.decision.action, {
            requestId: original.decision.requestId, expectedRevision: original.decision.expectedRevision,
          })
          : original.outcome ? await io.read(original.operationId) : await io.prepare(original.operationId, original.target);
        if (!options.isCurrent() || snapshot.state?.operationId !== original.operationId) return;
        const state = acceptCloudCredentialRemovalOutcome(snapshot.state, incoming);
        save(state); decisionAcknowledged = acknowledged(state);
        if (state.outcome?.state === "removed" && !removedPublished) {
          removedPublished = true;
          try { await options.onRemoved?.(state.target); } catch { /* committed removal stays authoritative */ }
        }
      } catch (error) {
        if (options.isCurrent()) publish({ state: snapshot.state, busy: true,
          error: error instanceof Error ? error.message.slice(0, 1000) : "Cloud connection change is pending." });
      } finally {
        flight = null;
        publish({ ...snapshot, busy: false });
        schedule();
      }
    })();
    void task.then(finish, fail); return running;
  }
  const decide = async (action: "confirm" | "cancel") => {
    if (!options.isCurrent() || (action === "confirm" && !attached) || !snapshot.state || terminal(snapshot.state)) return;
    const next = decideCloudCredentialRemovalState(snapshot.state, action, uuid());
    if (next === snapshot.state && !next.decision) return;
    if (next !== snapshot.state) { save(next); decisionAcknowledged = false; }
    await pump();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async start(target: CloudCredentialRemovalTarget) {
      if (!options.isCurrent() || !attached) throw new Error("This cloud account is no longer active.");
      if (snapshot.state && !terminal(snapshot.state)) {
        if (JSON.stringify(snapshot.state.target) !== JSON.stringify(target)) throw new Error("Another cloud connection change is pending.");
        return flight ?? pump();
      }
      const prior = findCloudCredentialRemovalIntent(options.userId, target);
      save(prior ?? beginCloudCredentialRemoval(uuid(), target));
      decisionAcknowledged = acknowledged(prior); removedPublished = false;
      await pump();
    },
    decide,
    retry: pump,
    attach() { attached = true; schedule(); },
    async detach() {
      attached = false; stopTimer();
      // A submitted Yes (including an unknown ACK) survives this surface.
      // An in-flight prepare may establish the revision needed for cancellation.
      if (snapshot.state?.decision) return;
      if (flight) await flight;
      if (options.isCurrent() && !snapshot.state?.decision) await decide("cancel");
    },
  };
}
