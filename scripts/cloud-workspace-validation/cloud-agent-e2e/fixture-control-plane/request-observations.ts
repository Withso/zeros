import { randomUUID } from "node:crypto";
import { z } from "zod";

// Script-only HTTP measurements. Neither these labels nor interval membership
// establishes a causal foreground/background edge or production CP cost.
export const FIXTURE_REQUEST_ROUTES = Object.freeze(["registration", "heartbeat", "actor", "commands", "execution", "events", "recordHead", "recordAppend", "rendererPrepare",
  "bootBootstrap", "bootSync", "bootActivate", "bootRefresh", "actorConfirm", "warmContext", "mirror", "seal", "credentialControls", "unknown"] as const);
export type FixtureRoute = typeof FIXTURE_REQUEST_ROUTES[number];
const operationRoutes = {
  "engine.register": "registration", "engine.heartbeat": "heartbeat",
  "client.admit": "actor", "client.renew": "actor",
  "commands.snapshot": "commands", "commands.read": "commands", "commands.mutate": "commands",
  "commands.claim": "commands", "commands.settle": "commands", "commands.stop": "commands",
  "credentials.admit": "execution", "credentials.validate": "execution", "credentials.renew": "execution",
  "credentials.release": "execution", "credentials.refresh": "execution", "credentials.background": "execution",
  "credentials.authorize-action": "execution", "credentials.customization": "execution", "credentials.terminal-environment": "execution",
  "events.append": "events", "events.replay": "events", "records.head": "recordHead", "records.sync": "recordAppend",
  "renderer.prepare": "rendererPrepare",
  "boot.bootstrap": "bootBootstrap", "boot.sync": "bootSync", "boot.activate": "bootActivate",
  "boot.refresh": "bootRefresh", "actor.confirm": "actorConfirm", "context.warm": "warmContext",
  "commands.mirror": "mirror",
  "commands.seal": "seal",
  "credentials.controls": "credentialControls",
} as const satisfies Record<string, FixtureRoute>;
type KnownOperation = keyof typeof operationRoutes;
export const FIXTURE_REQUEST_OPERATIONS = Object.freeze(["unknown", ...(Object.keys(operationRoutes) as KnownOperation[])] as const);
export type FixtureOperation = typeof FIXTURE_REQUEST_OPERATIONS[number];
export type FixtureRequestDelay = Readonly<{ route: FixtureRoute; operation?: KnownOperation; delayMs: number }>;
type Counts<Key extends string> = Readonly<Partial<Record<Key, number>>>;

export type MeasurementCheckpoint = Readonly<{
  version: 1; fixtureInstanceId: string; clockDomainId: string; clockSource: "node-process-hrtime";
  atUs: number; ingressSequence: number; completionSequence: number; inFlight: number;
  routeCounts: Counts<FixtureRoute>; completionRouteCounts: Counts<FixtureRoute>;
  completionOperationCounts: Counts<FixtureOperation>;
}>;
export type RequestObservation = Readonly<{
  route: FixtureRoute; method: "GET" | "POST" | "OTHER"; operation: FixtureOperation;
  arrivalSequence: number; completionSequence: number | null;
  arrivedAtUs: number; completedAtUs: number | null; status: number | null; beganBeforeWindow: boolean;
}>;
export type MeasurementWindow = Readonly<{
  version: 1; fixtureInstanceId: string; clockDomainId: string; clockSource: "node-process-hrtime";
  startAtUs: number; endAtUs: number; ingressCount: number; completionCount: number;
  routeCounts: Counts<FixtureRoute>; completionRouteCounts: Counts<FixtureRoute>;
  operationArrivalCounts: Counts<FixtureOperation> | null; completionOperationCounts: Counts<FixtureOperation>;
  inFlightAtStart: number; inFlightAtEnd: number; activeHandlers: number;
  detailsComplete: boolean; countersComplete: boolean;
  causalCoverage: "unavailable"; foregroundIngressCount: null; backgroundIngressCount: null;
  unknownCausalIngressCount: number; unknownCausalPendingAtStart: number;
  requests: readonly RequestObservation[];
}>;
type RecordEntry = {
  route: FixtureRoute; method: "GET" | "POST" | "OTHER"; operation: FixtureOperation;
  arrivalSequence: number; arrivedAtUs: number; operationJournal: number;
  completionSequence: number | null; completedAtUs: number | null; status: number | null;
};
type CheckpointState = { journal: number; ordinal: number; activeHandlers: number; countersComplete: boolean };
const invalidCheckpoint = () => { throw new Error("fixture_measurement_checkpoint_invalid"); };
function copyCounts<Key extends string>(counts: Partial<Record<Key, number>>): Counts<Key> { return Object.freeze({ ...counts }); }
function difference<Key extends string>(before: Counts<Key>, after: Counts<Key>): Counts<Key> {
  const counts: Partial<Record<Key, number>> = {};
  for (const key of Object.keys(after) as Key[]) {
    const value = after[key]! - (before[key] ?? 0);
    if (value < 0) invalidCheckpoint();
    if (value) counts[key] = value;
  }
  return copyCounts(counts);
}

export class FixtureRequestObservations {
  private readonly fixtureInstanceId = randomUUID();
  private readonly clockDomainId = randomUUID();
  private readonly checkpoints = new WeakMap<MeasurementCheckpoint, CheckpointState>();
  private readonly ring: RecordEntry[] = [];
  private readonly pending = new Map<number, RecordEntry>();
  private readonly routeCounts: Partial<Record<FixtureRoute, number>> = {};
  private readonly completionRouteCounts: Partial<Record<FixtureRoute, number>> = {};
  private readonly completionOperationCounts: Partial<Record<FixtureOperation, number>> = {};
  private readonly delays: readonly FixtureRequestDelay[];
  private ingressSequence = 0;
  private completionSequence = 0;
  private journal = 0;
  private checkpointOrdinal = 0;
  private inFlight = 0;
  private countersComplete = true;

  constructor(private readonly retainedCount = 2048, delays: readonly FixtureRequestDelay[] = []) {
    if (!Number.isSafeInteger(retainedCount) || retainedCount < 1 || retainedCount > 2048)
      throw new Error("fixture_request_observation_retention_invalid");
    const parsed = z.array(z.object({ route: z.enum(FIXTURE_REQUEST_ROUTES), operation: z.enum(Object.keys(operationRoutes) as [KnownOperation, ...KnownOperation[]]).optional(),
      delayMs: z.number().int().min(0).max(5000) }).strict()).max(64).safeParse(delays);
    if (!parsed.success) throw new Error("fixture_request_delay_invalid");
    const selectors = new Set<string>();
    for (const selector of parsed.data) {
      const key = `${selector.route}:${selector.operation ?? ""}`;
      if (selectors.has(key) || selector.operation && operationRoutes[selector.operation] !== selector.route)
        throw new Error("fixture_request_delay_invalid");
      selectors.add(key);
      const routeDelay = parsed.data.find(other => other.route === selector.route && !other.operation)?.delayMs ?? 0;
      if (selector.operation && routeDelay + selector.delayMs > 5000) throw new Error("fixture_request_delay_invalid");
    }
    this.delays = Object.freeze(parsed.data.map(selector => Object.freeze(selector)));
  }

  nowUs(): number {
    const value = Number(process.hrtime.bigint() / 1000n);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("fixture_measurement_clock_invalid");
    return value;
  }
  private increment(value: number): number {
    if (value < Number.MAX_SAFE_INTEGER) return value + 1;
    this.countersComplete = false;
    return Number.MAX_SAFE_INTEGER;
  }
  arrive(route: FixtureRoute, method: string | undefined, arrivedAtUs: number): RecordEntry {
    this.ingressSequence = this.increment(this.ingressSequence);
    this.journal = this.increment(this.journal);
    this.inFlight = this.increment(this.inFlight);
    this.routeCounts[route] = this.increment(this.routeCounts[route] ?? 0);
    const record: RecordEntry = { route, method: method === "GET" || method === "POST" ? method : "OTHER", operation: "unknown",
      arrivalSequence: this.ingressSequence, arrivedAtUs, operationJournal: this.journal,
      completionSequence: null, completedAtUs: null, status: null };
    this.ring.push(record);
    if (this.ring.length > this.retainedCount) this.ring.shift();
    // The server also bounds active handlers. Keep pending details separately
    // so an old request crossing a measurement window cannot silently vanish.
    if (this.pending.size < 256) this.pending.set(record.arrivalSequence, record);
    return record;
  }
  classify(record: RecordEntry, operation: FixtureOperation): void {
    if (record.completionSequence !== null) return;
    if (operation !== "unknown" && operationRoutes[operation] !== record.route) return;
    this.journal = this.increment(this.journal);
    record.operation = operation; record.operationJournal = this.journal;
  }
  complete(record: RecordEntry, status: number | null): void {
    if (record.completionSequence !== null) return;
    this.completionSequence = this.increment(this.completionSequence);
    this.journal = this.increment(this.journal);
    this.inFlight--;
    this.completionRouteCounts[record.route] = this.increment(this.completionRouteCounts[record.route] ?? 0);
    this.completionOperationCounts[record.operation] = this.increment(this.completionOperationCounts[record.operation] ?? 0);
    record.completionSequence = this.completionSequence; record.completedAtUs = this.nowUs();
    record.status = status !== null && Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
    this.pending.delete(record.arrivalSequence);
  }
  drainClosed(): void {
    // Called only after the server and all handlers have positively closed.
    // Socket-close delivery can trail server.close's callback; unfinished
    // records are therefore aborted completions, never successful responses.
    for (const record of new Set([...this.pending.values(), ...this.ring]))
      if (record.completionSequence === null) this.complete(record, null);
    if (this.inFlight !== 0) this.countersComplete = false;
  }
  checkpoint(activeHandlers: number): MeasurementCheckpoint {
    const checkpoint: MeasurementCheckpoint = Object.freeze({ version: 1, fixtureInstanceId: this.fixtureInstanceId,
      clockDomainId: this.clockDomainId, clockSource: "node-process-hrtime", atUs: this.nowUs(),
      ingressSequence: this.ingressSequence, completionSequence: this.completionSequence, inFlight: this.inFlight,
      routeCounts: copyCounts(this.routeCounts), completionRouteCounts: copyCounts(this.completionRouteCounts),
      completionOperationCounts: copyCounts(this.completionOperationCounts) });
    this.checkpoints.set(checkpoint, { journal: this.journal, ordinal: ++this.checkpointOrdinal,
      activeHandlers, countersComplete: this.countersComplete });
    return checkpoint;
  }
  window(start: MeasurementCheckpoint, end: MeasurementCheckpoint): MeasurementWindow {
    const first = this.checkpoints.get(start), last = this.checkpoints.get(end);
    if (!first || !last || first.ordinal > last.ordinal || start.atUs > end.atUs ||
        start.ingressSequence > end.ingressSequence || start.completionSequence > end.completionSequence) return invalidCheckpoint();
    const ingressCount = end.ingressSequence - start.ingressSequence;
    const records = new Map([...this.ring, ...this.pending.values()].map(record => [record.arrivalSequence, record]));
    const requests = [...records.values()].filter(record => record.arrivalSequence <= end.ingressSequence &&
      (record.arrivalSequence > start.ingressSequence || record.completionSequence === null || record.completionSequence > start.completionSequence))
      .sort((a, b) => a.arrivalSequence - b.arrivalSequence).slice(0, this.retainedCount).map(record => {
        const completed = record.completionSequence !== null && record.completionSequence <= end.completionSequence;
        return Object.freeze({ route: record.route, method: record.method,
          operation: record.operationJournal <= last.journal ? record.operation : "unknown",
          arrivalSequence: record.arrivalSequence, arrivedAtUs: record.arrivedAtUs,
          completionSequence: completed ? record.completionSequence : null,
          completedAtUs: completed ? record.completedAtUs : null, status: completed ? record.status : null,
          beganBeforeWindow: record.arrivalSequence <= start.ingressSequence });
      });
    const countersComplete = first.countersComplete && last.countersComplete;
    const detailsComplete = countersComplete && requests.length === ingressCount + start.inFlight;
    const operationCounts: Partial<Record<FixtureOperation, number>> = {};
    if (detailsComplete) for (const record of requests) if (!record.beganBeforeWindow)
      operationCounts[record.operation] = (operationCounts[record.operation] ?? 0) + 1;
    return Object.freeze({ version: 1, fixtureInstanceId: this.fixtureInstanceId, clockDomainId: this.clockDomainId,
      clockSource: "node-process-hrtime", startAtUs: start.atUs, endAtUs: end.atUs,
      ingressCount, completionCount: end.completionSequence - start.completionSequence,
      routeCounts: difference(start.routeCounts, end.routeCounts),
      completionRouteCounts: difference(start.completionRouteCounts, end.completionRouteCounts),
      operationArrivalCounts: detailsComplete ? copyCounts(operationCounts) : null,
      completionOperationCounts: difference(start.completionOperationCounts, end.completionOperationCounts),
      inFlightAtStart: start.inFlight, inFlightAtEnd: end.inFlight, activeHandlers: last.activeHandlers,
      detailsComplete, countersComplete, causalCoverage: "unavailable", foregroundIngressCount: null, backgroundIngressCount: null,
      unknownCausalIngressCount: ingressCount, unknownCausalPendingAtStart: start.inFlight, requests: Object.freeze(requests) });
  }
  async delay(route: FixtureRoute, operation: FixtureOperation | undefined, signal: AbortSignal): Promise<boolean> {
    const delayMs = this.delays.find(selector => selector.route === route && selector.operation === operation)?.delayMs ?? 0;
    if (signal.aborted) return false;
    if (!delayMs) return true;
    return new Promise(resolve => {
      const finish = (completed: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", aborted); resolve(completed); };
      const aborted = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
}
