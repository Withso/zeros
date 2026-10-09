import { z } from "zod";
import { FIXTURE_REQUEST_ROUTES, FIXTURE_REQUEST_OPERATIONS } from "./fixture-control-plane/request-observations";
import { HarnessFailure } from "./assertions";

const amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const count = amount.int();
const routes = z.enum(FIXTURE_REQUEST_ROUTES), operations = z.enum(FIXTURE_REQUEST_OPERATIONS);
const counts = (values: readonly string[]) => z.record(z.string(), count).superRefine((value, context) => {
  if (Object.keys(value).some(key => !values.includes(key))) context.addIssue({ code: "custom" });
});
const observation = z.object({ route: routes, method: z.enum(["GET", "POST", "OTHER"]), operation: operations,
  arrivalSequence: count.positive(), completionSequence: count.positive().nullable(), arrivedAtUs: count,
  completedAtUs: count.nullable(), status: z.number().int().min(100).max(599).nullable(), beganBeforeWindow: z.boolean() }).strict();
const windowSchema = z.object({ version: z.literal(1), fixtureInstanceId: z.uuid(), clockDomainId: z.uuid(),
  clockSource: z.literal("node-process-hrtime"), startAtUs: count, endAtUs: count, ingressCount: count, completionCount: count,
  routeCounts: counts(FIXTURE_REQUEST_ROUTES), completionRouteCounts: counts(FIXTURE_REQUEST_ROUTES),
  operationArrivalCounts: counts(FIXTURE_REQUEST_OPERATIONS).nullable(), completionOperationCounts: counts(FIXTURE_REQUEST_OPERATIONS),
  inFlightAtStart: count, inFlightAtEnd: count, activeHandlers: count, detailsComplete: z.boolean(), countersComplete: z.boolean(),
  causalCoverage: z.literal("unavailable"), foregroundIngressCount: z.null(), backgroundIngressCount: z.null(),
  unknownCausalIngressCount: count, unknownCausalPendingAtStart: count, requests: z.array(observation).max(2048) }).strict();
const calibrationSchema = z.object({ clockDomainId: z.uuid(), clientClockId: z.uuid(), clientBeforeAtMs: amount,
  fixtureSampleAtUs: count, clientAfterAtMs: amount }).strict();
const rangeSchema = z.object({ min: amount, max: amount }).strict().refine(value => value.min <= value.max);
const intervalSchema = z.object({ clientClockId: z.uuid(),
  throughStage: z.enum(["native_write", "native_acceptance_ack", "sdk_run_created", "typed_auth_failure"]),
  fromAtMs: rangeSchema, throughAtMs: rangeSchema }).strict();
type Counts = Record<string, number>;
const total = (value: Counts) => Object.values(value).reduce((sum, next) => sum + next, 0);
function sameCounts(left: Counts, right: Counts): boolean {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => (left[key] ?? 0) === (right[key] ?? 0));
}
function parse<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  try { const parsed = schema.safeParse(value); if (parsed.success) return parsed.data; } catch {}
  throw new HarnessFailure(code);
}

/** This validates a fixture-owned arrival window; it cannot supply missing
 * authenticated origins/wait edges, actual PostgreSQL cost or CP relay bytes.
 * Clock uncertainty gives inclusive count bounds, never an assumed exact zero.
 * The caller obtains all windows/calibration from actual trusted producers. */
function validateFixtureWindow(input: unknown) {
  const window = parse(windowSchema, input, "fixture_measurement_invalid");
  if (!window.detailsComplete || !window.countersComplete) throw new HarnessFailure("ingress_details_incomplete");
  const routeCounts: Counts = {}, completionRouteCounts: Counts = {}, operationCounts: Counts = {}, completionOperationCounts: Counts = {};
  let pending = 0, completions = 0;
  const arrivals = new Set<number>(), completedSequences = new Set<number>();
  for (const row of window.requests) {
    if (arrivals.has(row.arrivalSequence) || row.arrivedAtUs > window.endAtUs ||
        (row.beganBeforeWindow ? row.arrivedAtUs > window.startAtUs : row.arrivedAtUs < window.startAtUs) ||
        (row.completionSequence === null) !== (row.completedAtUs === null) ||
        row.completedAtUs !== null && (row.completedAtUs < row.arrivedAtUs || row.completedAtUs < window.startAtUs || row.completedAtUs > window.endAtUs) ||
        row.completionSequence === null && row.status !== null)
      throw new HarnessFailure("fixture_measurement_invalid");
    arrivals.add(row.arrivalSequence);
    if (row.beganBeforeWindow) pending++;
    else {
      routeCounts[row.route] = (routeCounts[row.route] ?? 0) + 1;
      operationCounts[row.operation] = (operationCounts[row.operation] ?? 0) + 1;
    }
    if (row.completionSequence !== null) {
      if (completedSequences.has(row.completionSequence)) throw new HarnessFailure("fixture_measurement_invalid");
      completedSequences.add(row.completionSequence); completions++;
      completionRouteCounts[row.route] = (completionRouteCounts[row.route] ?? 0) + 1;
      completionOperationCounts[row.operation] = (completionOperationCounts[row.operation] ?? 0) + 1;
    }
  }
  if (window.startAtUs > window.endAtUs || window.requests.length !== window.ingressCount + window.inFlightAtStart ||
      pending !== window.inFlightAtStart || completions !== window.completionCount ||
      window.inFlightAtStart + window.ingressCount - window.completionCount !== window.inFlightAtEnd ||
      window.unknownCausalIngressCount !== window.ingressCount || window.unknownCausalPendingAtStart !== window.inFlightAtStart ||
      total(window.routeCounts) !== window.ingressCount || total(window.completionRouteCounts) !== window.completionCount ||
      !sameCounts(routeCounts, window.routeCounts) || !window.operationArrivalCounts || !sameCounts(operationCounts, window.operationArrivalCounts) ||
      !sameCounts(completionRouteCounts, window.completionRouteCounts) || !sameCounts(completionOperationCounts, window.completionOperationCounts))
    throw new HarnessFailure("fixture_measurement_invalid");
  return window;
}
function windowCounts(window: z.infer<typeof windowSchema>) {
  return { ingressCount: window.ingressCount, completionCount: window.completionCount, routeCounts: window.routeCounts,
    operationArrivalCounts: window.operationArrivalCounts!, completionRouteCounts: window.completionRouteCounts,
    completionOperationCounts: window.completionOperationCounts, pendingAtStart: window.inFlightAtStart, pendingAtEnd: window.inFlightAtEnd };
}

/** Exact producer-checkpoint counts for Send/result, without attributing
 * requests to an uncertain native boundary or a causal foreground edge. */
export function summarizeFixtureWindow(input: unknown) { return windowCounts(validateFixtureWindow(input)); }

export function summarizeFixtureIngress(input: unknown, clock: unknown, bounds: unknown) {
  const window = validateFixtureWindow(input);
  const calibration = parse(calibrationSchema, clock, "ingress_calibration_invalid");
  const interval = parse(intervalSchema, bounds, "ingress_calibration_invalid");
  if (window.clockDomainId !== calibration.clockDomainId || interval.clientClockId !== calibration.clientClockId ||
      calibration.clientBeforeAtMs > calibration.clientAfterAtMs || calibration.clientAfterAtMs - calibration.clientBeforeAtMs > 5000 ||
      interval.fromAtMs.min > interval.throughAtMs.min || interval.fromAtMs.max > interval.throughAtMs.max)
    throw new HarnessFailure("ingress_calibration_invalid");
  // The fixture records floor(hrtime / 1000), so both the sampled anchor and
  // each request stamp represent a one-microsecond interval, not a point.
  const resolutionMs = 0.001;
  const offsetMin = calibration.clientBeforeAtMs - calibration.fixtureSampleAtUs / 1000 - resolutionMs;
  const offsetMax = calibration.clientAfterAtMs - calibration.fixtureSampleAtUs / 1000;
  const convert = (atUs: number) => ({ min: atUs / 1000 + offsetMin, max: atUs / 1000 + offsetMax + resolutionMs });
  if (convert(window.startAtUs).max > interval.fromAtMs.min || convert(window.endAtUs).min < interval.throughAtMs.max)
    throw new HarnessFailure("ingress_interval_outside_window");
  const arrivalCount = { min: 0, max: 0 }, pendingAtStartCount = { min: 0, max: 0 };
  const membership = (certain: boolean, possible: boolean) => certain ? "certain" as const : possible ? "possible" as const : "outside" as const;
  const requests = window.requests.map(row => {
    const arrived = convert(row.arrivedAtUs), completed = row.completedAtUs === null ? null : convert(row.completedAtUs);
    const arrivalCertain = arrived.min >= interval.fromAtMs.max && arrived.max <= interval.throughAtMs.min;
    const arrivalPossible = arrived.max >= interval.fromAtMs.min && arrived.min <= interval.throughAtMs.max;
    const pendingCertain = arrived.max <= interval.fromAtMs.min && (!completed || completed.min > interval.fromAtMs.max);
    const pendingPossible = arrived.min <= interval.fromAtMs.max && (!completed || completed.max > interval.fromAtMs.min);
    if (arrivalCertain) arrivalCount.min++;
    if (arrivalPossible) arrivalCount.max++;
    if (pendingCertain) pendingAtStartCount.min++;
    if (pendingPossible) pendingAtStartCount.max++;
    // The parsed rows contain only closed inventory labels and scalars. Keep
    // their original producer stamps so interval identities remain auditable.
    // Neither a route nor temporal overlap supplies an authenticated origin
    // or evidence that Send awaited this particular request.
    return { ...row, arrivedAtClientMs: arrived, completedAtClientMs: completed,
      arrivalInInterval: membership(arrivalCertain, arrivalPossible),
      pendingAtIntervalStart: membership(pendingCertain, pendingPossible),
      origin: "unverified" as const, spanId: null, waitId: null };
  });
  return { version: 1 as const, fixtureInstanceId: window.fixtureInstanceId, clockDomainId: window.clockDomainId,
    clientClockId: calibration.clientClockId, fixtureTimestampResolutionUs: 1 as const,
    calibrationUncertaintyMs: calibration.clientAfterAtMs - calibration.clientBeforeAtMs + resolutionMs,
    fullWindow: windowCounts(window),
    interval: { throughStage: interval.throughStage, arrivalCount, pendingAtStartCount }, requests,
    causalCoverage: "unavailable" as const, foregroundIngressCount: null, backgroundIngressCount: null };
}
