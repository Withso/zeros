// Measured native acceptance, separate from source/cache admission and the
// emergency shutdown guard. Never accept absent or development-only evidence.
export const designPerformanceBudgets = Object.freeze({
  frameP95Ms: 16.7, frameP99Ms: 33.3, inputP95Ms: 50,
  incrementalIdleCpu: 1, idleSeconds: 60, repetitions: 3,
  minimumPresentations: 120, minimumCycles: 100, retainedGrowth: .05,
  // Reference workload: all nine fixtures, 256-frame overview, 60 Hz Retina.
  // These are product acceptance targets, not OS/GPU allocation quotas.
  appPeakBytes: 2560 * 1024 ** 2, gpuPeakBytes: 768 * 1024 ** 2,
  settledAppBytes: 2048 * 1024 ** 2,
});

const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const bytes = value => Number.isSafeInteger(value) && value > 0;
export function percentile(values, percentile) {
  if (!values.length || values.some(value => !finite(value))) throw new Error("Missing or invalid measurement samples.");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)];
}
const distribution = values => ({ samples: values.length, p50: percentile(values, .5),
  p95: percentile(values, .95), p99: percentile(values, .99), max: percentile(values, 1) });

/** Chromium's PipelineReporter closes at compositor presentation. EventLatency
 * without display_trace_id may be non-damaging/coalesced input; it is not
 * presentation evidence. Match reusable async IDs by process and event type.
 * Scope to the app renderer, never aggregate a capture/guest/other app's frames.
 * The observation also covers native-driver startup. Preserve those paints,
 * but start gesture intervals at the first actual wheel presentation. A hover
 * paint can already be in flight when wheel input arrives; its later display
 * is still setup rather than wheel feedback. Every wheel latency (including
 * the first response) and every subsequent presentation still counts.
 * This measures Chromium presentation, not optical input-to-photon latency. */
export function analyzeDesignPresentationTrace(events, { rendererPid, startUs, endUs }) {
  if (!Number.isSafeInteger(rendererPid) || rendererPid <= 0 || !finite(startUs) || !finite(endUs) || endUs <= startUs)
    throw new Error("Invalid presentation observation window.");
  const pending = new Map(), presented = new Set(), latency = [];
  let dropped = 0, partial = 0, noUpdate = 0, incomplete = 0, firstInputUs = null, firstInputPresentationUs = null;
  for (const event of events.filter(e => e.pid === rendererPid && ["PipelineReporter", "EventLatency"].includes(e.name)).sort((a, b) => a.ts - b.ts)) {
    if (!finite(event.ts)) throw new Error("Invalid native trace timestamp.");
    const id = event.id2?.local ?? event.id2?.global ?? event.id;
    if (id === undefined || !["b", "e"].includes(event.ph)) continue;
    const key = `${event.name}:${event.pid}:${event.id2?.global === undefined ? "local" : "global"}:${id}`;
    if (event.ph === "b") {
      if (pending.has(key)) throw new Error("Native trace has ambiguous open spans.");
      pending.set(key, event); continue;
    }
    const begin = pending.get(key); pending.delete(key);
    if (!begin) continue; // A span can begin before tracing was enabled.
    if (begin.ts < startUs || event.ts > endUs) continue;
    if (event.name === "PipelineReporter") {
      const state = begin.args?.frame_reporter?.state;
      if (state === "STATE_NO_UPDATE_DESIRED") { noUpdate++; continue; }
      if (state === "STATE_DROPPED") { dropped++; continue; }
      if (state !== "STATE_PRESENTED_ALL" && !state?.startsWith("STATE_PRESENTED_PARTIAL"))
        throw new Error(`Unsupported Chromium presentation state: ${String(state)}`);
      if (state !== "STATE_PRESENTED_ALL") partial++;
      presented.add(event.ts);
    } else {
      const input = begin.args?.event_latency;
      if (input?.event_type === "MOUSE_WHEEL") {
        firstInputUs = firstInputUs === null ? begin.ts : Math.min(firstInputUs, begin.ts);
        if (input.display_trace_id !== undefined) {
          latency.push((event.ts - begin.ts) / 1000);
          firstInputPresentationUs = firstInputPresentationUs === null ? event.ts : Math.min(firstInputPresentationUs, event.ts);
        }
      }
    }
  }
  for (const begin of pending.values()) if (begin.ts >= startUs && begin.ts <= endUs) incomplete++;
  const timestamps = [...presented].sort((a, b) => a - b);
  if (timestamps.length < 2 || !latency.length) throw new Error("Insufficient native presentation evidence; event/RAF counts are not frame timing.");
  const active = timestamps.filter(time => time >= firstInputPresentationUs);
  if (active.length < 2) throw new Error("Insufficient native presentation evidence after wheel feedback begins.");
  const intervals = active.slice(1).map((time, i) => (time - active[i]) / 1000);
  return { presented: active.length, dropped, partial, noUpdate, incomplete,
    observation: { presented: timestamps.length, firstInputUs, firstInputPresentationUs, preInputPresented: timestamps.length - active.length,
      frameIntervalMs: distribution(timestamps.slice(1).map((time, i) => (time - timestamps[i]) / 1000)) },
    frameIntervalMs: distribution(intervals), inputToPresentMs: distribution(latency) };
}

/** Native work is noisy, but missing observations are not a noise allowance.
 * Retain every repetition. Plateau uses ten-cycle medians against the fixed
 * pre-soak warm median; it cannot move its baseline forward to hide growth. */
export function assessDesignPerformance(report, budgets = designPerformanceBudgets) {
  const failures = new Set();
  const require = (condition, name) => { if (!condition) failures.add(name); };
  require(!report?.error && !report?.cleanupError, "native-run-errors");
  require(report?.runtimeRetired === true, "native-runtime-retirement");
  require(report?.platform === "darwin" && report.build?.mode === "production" && report.build?.hmr === false, "production-native-build");
  require(report?.runtime?.localDevelopment === false && report?.authorization?.signedIn === true &&
    report.authorization.confirmedOrganization === true, "owner-authorization");
  require(/^[a-f0-9]{64}$/.test(report?.build?.sourceDigest ?? "") &&
    report.build.sourceDigest === report.build.finalSourceDigest, "source-identity");
  require(report?.sourcePreserved === true, "authored-source");
  const openings = Array.isArray(report?.openings) ? report.openings : [];
  for (const fixture of ["personal", "organization-local", "2", "32", "128", "256", "complex-32", "mixed-2", "overview-256"]) {
    const visits = openings.filter(row => row.fixture === fixture);
    require(visits.length === 1 && finite(visits[0].coldReadyMs) && finite(visits[0].warmReadyMs), `${fixture}-opening-coverage`);
  }
  const scenarios = Array.isArray(report?.scenarios) ? report.scenarios : [];
  require(scenarios.some(s => s.name === "frame-resize-cancel" && finite(s.observedDurationMs)), "resize-coverage");
  require(scenarios.some(s => s.name === "external-source-edit" && finite(s.observedReadyMs)), "editing-coverage");
  require(scenarios.some(s => s.name === "native-capture" && s.width > 0 && s.height > 0 && s.bytes > 0 && s.stale !== true), "capture-coverage");
  require(report?.pressureCovered === 256, "pressure-coverage");
  const interactions = Array.isArray(report?.interactions) ? report.interactions : [];
  for (const name of ["pan", "zoom"]) {
    const runs = interactions.filter(run => run.name === name);
    require(runs.length >= budgets.repetitions && new Set(runs.map(run => run.repeat)).size === runs.length, `${name}-repetitions`);
    for (const run of runs) {
      const frames = run.frameIntervalMs, input = run.inputToPresentMs;
      require(Number.isSafeInteger(run.presented) && run.presented >= budgets.minimumPresentations &&
        frames?.samples >= budgets.minimumPresentations - 1 && input?.samples >= budgets.minimumPresentations &&
        run.cameraChanges >= budgets.minimumPresentations && run.incomplete === 0, `${name}-presentation-coverage`);
      require(finite(frames?.p95) && finite(frames?.p99) && frames.p95 <= budgets.frameP95Ms && frames.p99 <= budgets.frameP99Ms, `${name}-frame-time`);
      require(finite(input?.p95) && input.p95 < budgets.inputP95Ms, `${name}-input-latency`);
      require(run.partial === 0, `${name}-partial-frames`);
    }
  }
  const idle = Array.isArray(report?.idle) ? report.idle : [];
  require(idle.length >= budgets.repetitions, "idle-repetitions");
  const idleDeltas = idle.map(run => {
    require(finite(run.seconds) && run.seconds >= budgets.idleSeconds && finite(run.visibleCpu) && finite(run.hiddenCpu), "idle-evidence");
    require(run.hiddenJobs === 0, "hidden-work");
    return run.visibleCpu - run.hiddenCpu;
  });
  require(idleDeltas.length > 0 && idleDeltas.every(delta => Number.isFinite(delta) && delta < budgets.incrementalIdleCpu), "idle-cpu");
  const memory = report?.memory ?? {}, cycles = Array.isArray(memory.cycles) ? memory.cycles : [], warm = Array.isArray(memory.warm) ? memory.warm : [];
  const settled = Array.isArray(memory.settled) ? memory.settled : [];
  require(cycles.length >= budgets.minimumCycles && cycles.every((cycle, i) => cycle.cycle === i + 1 &&
    cycle.returned === true && cycle.ownerRoundTrip === true && cycle.suspended === true), "memory-cycle-coverage");
  for (const scenario of ["appHidden", "sourceChanged", "pressure"])
    require(cycles.filter(cycle => cycle[scenario] === true).length >= Math.ceil(budgets.minimumCycles / 10), `memory-${scenario}-coverage`);
  const completeBlocks = settled.length === Math.floor(cycles.length / 10) && settled.length >= Math.ceil(budgets.minimumCycles / 10) &&
    settled.every((block, i) => block.throughCycle === (i + 1) * 10 && Array.isArray(block.samples) && block.samples.length >= 10);
  require(completeBlocks, "memory-settled-coverage");
  const retained = settled.flatMap(block => Array.isArray(block.samples) ? block.samples : []);
  const valid = warm.length >= 10 && completeBlocks && [...warm, ...cycles, ...retained].every(sample => bytes(sample.appBytes) && bytes(sample.gpuBytes));
  require(valid && bytes(memory.peakAppBytes) && bytes(memory.peakGpuBytes), "memory-evidence");
  const plateau = [];
  let warmMedian = null;
  if (valid) {
    warmMedian = percentile(warm.map(sample => sample.appBytes), .5);
    for (const block of settled) {
      const median = percentile(block.samples.map(sample => sample.appBytes), .5);
      plateau.push({ throughCycle: block.throughCycle, median, growth: median / warmMedian - 1 });
    }
    require(plateau.every(block => block.growth <= budgets.retainedGrowth), "memory-plateau");
    require(warmMedian <= budgets.settledAppBytes && plateau.every(block => block.median <= budgets.settledAppBytes), "memory-settled");
    require([...warm, ...cycles, ...retained].every(s => s.appBytes <= memory.peakAppBytes && s.gpuBytes <= memory.peakGpuBytes), "memory-peak-coverage");
  }
  require(bytes(memory.peakAppBytes) && memory.peakAppBytes <= budgets.appPeakBytes, "app-peak");
  require(bytes(memory.peakGpuBytes) && memory.peakGpuBytes <= budgets.gpuPeakBytes, "gpu-peak");
  return { passed: failures.size === 0, failures: [...failures], budgets, idleDeltas, warmMedian, plateau };
}
