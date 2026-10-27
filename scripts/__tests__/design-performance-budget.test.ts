import { describe, expect, it } from "vitest";
import { analyzeDesignPresentationTrace, assessDesignPerformance, designPerformanceBudgets } from "../design-performance-budget.mjs";

// Chromium/Electron's actual asynchronous trace shape, observed on the Mac.
// Local IDs are reused and scoped to a process, not globally unique frame IDs.
function trace(frameCount = 180) {
  const events: Record<string, unknown>[] = [];
  for (let i = 0; i < frameCount; i++) {
    const ts = 1_000_000 + i * 16_666;
    events.push({ name: "PipelineReporter", ph: "b", pid: 10, tid: 11, ts,
      id2: { local: "0x3" }, args: { frame_reporter: { state: "STATE_PRESENTED_ALL", frame_sequence: i, frame_source: 1, layer_tree_host_id: 7 } } },
    { name: "PipelineReporter", ph: "e", pid: 10, tid: 11, ts: ts + 12_000, id2: { local: "0x3" }, args: {} },
    { name: "EventLatency", ph: "b", pid: 10, tid: 11, ts: ts - 2_000, id2: { local: "0x42" }, args: { event_latency: { event_type: "MOUSE_WHEEL", display_trace_id: i + 1, vsync_interval_ms: 16.666 } } },
    { name: "EventLatency", ph: "e", pid: 10, tid: 11, ts: ts + 12_000, id2: { local: "0x42" }, args: {} });
  }
  return events;
}
const analyze = (events: Record<string, unknown>[]) => analyzeDesignPresentationTrace(events, { rendererPid: 10, startUs: 0, endUs: 10_000_000 });

describe("native Design presentation evidence", () => {
  it("uses presentation endpoints and input-to-presentation spans, excluding other renderers and no-update frames", () => {
    const events = trace();
    events.push(...trace(20).map(e => ({ ...e, pid: 99 })));
    events.push({ name: "PipelineReporter", ph: "b", pid: 10, tid: 11, ts: 5_000_000, id2: { local: "0x3" }, args: { frame_reporter: { state: "STATE_NO_UPDATE_DESIRED" } } },
      { name: "PipelineReporter", ph: "e", pid: 10, tid: 11, ts: 9_000_000, id2: { local: "0x3" }, args: {} });
    const result = analyze(events.reverse());
    expect(result.presented).toBe(180);
    expect(result.frameIntervalMs.p95).toBeCloseTo(16.666);
    expect(result.inputToPresentMs.p95).toBe(14);
    expect(result.inputToPresentMs.samples).toBe(180);
  });

  it("does not equate synthetic event counts, RAF callbacks or incomplete spans with displayed frames", () => {
    expect(() => analyze([{ name: "AnimationFrame::Presentation", ph: "n", pid: 10, ts: 1000 },
      { name: "PipelineReporter", ph: "b", pid: 10, ts: 100, id2: { local: "x" }, args: {} }])).toThrow(/presentation evidence/);
  });

  it("keeps pre-input paints as observation evidence without counting driver startup as gesture pacing", () => {
    const events = trace();
    for (const ts of [100_000, 300_000, 700_000]) events.push(
      { name: "PipelineReporter", ph: "b", pid: 10, tid: 11, ts, id2: { local: "startup" },
        args: { frame_reporter: { state: "STATE_PRESENTED_ALL" } } },
      { name: "PipelineReporter", ph: "e", pid: 10, tid: 11, ts: ts + 12_000, id2: { local: "startup" }, args: {} },
    );
    const result = analyze(events);
    expect(result.presented).toBe(180);
    expect(result.frameIntervalMs.max).toBeCloseTo(16.666);
    expect(result.inputToPresentMs.samples).toBe(180);
    expect(result.observation).toMatchObject({ presented: 183, preInputPresented: 3, firstInputUs: 998_000 });
    expect(result.observation.frameIntervalMs.max).toBe(400);
  });

  it("starts gesture pacing at wheel presentation when a pending hover paint presents after input arrived", () => {
    const events = trace();
    const firstInput = events.find(e => e.name === "EventLatency" && e.ph === "b")!;
    firstInput.ts = 950_000;
    events.push({ name: "PipelineReporter", ph: "b", pid: 10, tid: 11, ts: 940_000, id2: { local: "pending-hover" },
      args: { frame_reporter: { state: "STATE_PRESENTED_ALL" } } },
    { name: "PipelineReporter", ph: "e", pid: 10, tid: 11, ts: 960_000, id2: { local: "pending-hover" }, args: {} });
    const result = analyze(events);
    expect(result.presented).toBe(180);
    expect(result.frameIntervalMs.max).toBeCloseTo(16.666);
    expect(result.inputToPresentMs.samples).toBe(180);
    expect(result.inputToPresentMs.max).toBe(62);
    expect(result.observation).toMatchObject({ presented: 181, firstInputUs: 950_000,
      firstInputPresentationUs: 1_012_000, preInputPresented: 1 });
    expect(result.observation.frameIntervalMs.max).toBe(52);
  });

  it("preserves a slow initial wheel response and later presentation gaps", () => {
    const events = trace();
    const firstInput = events.find(e => e.name === "EventLatency" && e.ph === "b")!;
    firstInput.ts = 850_000;
    // A real pacing gap after the first wheel was displayed still counts.
    for (const event of events.slice(4)) event.ts = Number(event.ts) + 100_000;
    const result = analyze(events);
    expect(result.presented).toBe(180);
    expect(result.inputToPresentMs.samples).toBe(180);
    expect(result.inputToPresentMs.max).toBe(162);
    expect(result.frameIntervalMs.max).toBeCloseTo(116.666);
  });

  it("records dropped and partially presented frames and preserves the timing tail", () => {
    const events = trace();
    const starts = events.filter(e => e.name === "PipelineReporter" && e.ph === "b");
    (starts[30].args as { frame_reporter: { state: string } }).frame_reporter.state = "STATE_DROPPED";
    (starts[40].args as { frame_reporter: { state: string } }).frame_reporter.state = "STATE_PRESENTED_PARTIAL";
    const result = analyze(events);
    expect(result.dropped).toBe(1); expect(result.partial).toBe(1);
    expect(result.frameIntervalMs.max).toBeCloseTo(33.332);
  });

  it("fails on unsupported trace states and duplicate open spans instead of silently selecting favourable records", () => {
    const events = trace();
    expect(() => analyze([...events, events[0]])).toThrow(/ambiguous/);
    (events[0].args as { frame_reporter: { state: string } }).frame_reporter.state = "NEW_CHROMIUM_STATE";
    expect(() => analyze(events)).toThrow(/Unsupported/);
  });
});

function passingReport() {
  return {
    platform: "darwin", build: { mode: "production", sourceDigest: "a".repeat(64), finalSourceDigest: "a".repeat(64), hmr: false },
    runtime: { localDevelopment: false }, authorization: { signedIn: true, confirmedOrganization: true },
    openings: ["personal", "organization-local", "2", "32", "128", "256", "complex-32", "mixed-2", "overview-256"].map(fixture => ({ fixture, coldReadyMs: 1000, warmReadyMs: 20 })),
    scenarios: [{ name: "frame-resize-cancel", observedDurationMs: 100 }, { name: "external-source-edit", observedReadyMs: 50 }, { name: "native-capture", width: 560, height: 360, bytes: 1024, stale: false }],
    pressureCovered: 256,
    interactions: ["pan", "zoom"].flatMap(name => [1, 2, 3].map(repeat => ({ name, repeat, ...analyze(trace()), cameraChanges: 150 }))),
    idle: [0, 1, 2].map(() => ({ seconds: 60, visibleCpu: 2.8, hiddenCpu: 2.2, hiddenJobs: 0 })),
    memory: { warm: Array(10).fill({ appBytes: 1200 * 1024 ** 2, gpuBytes: 200 * 1024 ** 2 }),
      settled: Array.from({ length: 10 }, (_, i) => ({ throughCycle: (i + 1) * 10,
        samples: Array.from({ length: 10 }, () => ({ appBytes: 1220 * 1024 ** 2, gpuBytes: 210 * 1024 ** 2 })) })),
      cycles: Array.from({ length: 100 }, (_, i) => ({ cycle: i + 1, returned: true, ownerRoundTrip: true, suspended: true,
        appHidden: (i + 1) % 10 === 0, sourceChanged: (i + 1) % 10 === 0, pressure: (i + 1) % 10 === 0,
        appBytes: 1220 * 1024 ** 2, gpuBytes: 210 * 1024 ** 2 })),
      peakAppBytes: 2000 * 1024 ** 2, peakGpuBytes: 600 * 1024 ** 2 },
    sourcePreserved: true, runtimeRetired: true,
  };
}

describe("Design performance acceptance", () => {
  it("accepts production presentation, repeated quiescent CPU and a bounded 100-cycle plateau", () => {
    expect(assessDesignPerformance(passingReport()).passed).toBe(true);
    expect(designPerformanceBudgets.minimumCycles).toBe(100);
  });

  it("refuses development evidence, changed sources, short soaks and partial owner/wake coverage", () => {
    for (const change of [
      (r: ReturnType<typeof passingReport>) => { r.build.mode = "development"; },
      (r: ReturnType<typeof passingReport>) => { r.build.finalSourceDigest = "b".repeat(64); },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles = r.memory.cycles.slice(0, 20); },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles[50].ownerRoundTrip = false; },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles[30].suspended = false; },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles.forEach(c => { c.sourceChanged = false; }); },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles.forEach(c => { c.pressure = false; }); },
      (r: ReturnType<typeof passingReport>) => { r.memory.cycles.forEach(c => { c.appHidden = false; }); },
    ]) { const r = passingReport(); change(r); expect(assessDesignPerformance(r).passed).toBe(false); }
  });

  it("rejects CPU, tail latency, absolute-memory and sustained-growth overruns separately", () => {
    const cpu = passingReport(); cpu.idle[1].visibleCpu = 6;
    expect(assessDesignPerformance(cpu).failures).toContain("idle-cpu");
    const latency = passingReport(); latency.interactions[0].inputToPresentMs.p95 = 60;
    expect(assessDesignPerformance(latency).failures).toContain("pan-input-latency");
    const leak = passingReport(); leak.memory.settled.slice(4).forEach(block => block.samples.forEach(s => { s.appBytes *= 1.2; }));
    expect(assessDesignPerformance(leak).failures).toContain("memory-plateau");
    const peak = passingReport(); peak.memory.peakGpuBytes = 900 * 1024 ** 2;
    expect(assessDesignPerformance(peak).failures).toContain("gpu-peak");
    const pacing = passingReport(); pacing.interactions[0].frameIntervalMs.p99 = 33.333;
    expect(assessDesignPerformance(pacing).failures).toContain("pan-frame-time");
  });

  it("compares retained memory at the same quiescent boundary while still enforcing interaction peaks", () => {
    const r = passingReport();
    r.memory.cycles.forEach(s => { s.appBytes = 1800 * 1024 ** 2; });
    expect(assessDesignPerformance(r).passed).toBe(true);
    r.memory.peakAppBytes = 3000 * 1024 ** 2;
    expect(assessDesignPerformance(r).failures).toContain("app-peak");
  });

  it("refuses missing, short, duplicated or non-finite settled memory blocks", () => {
    for (const change of [
      (r: ReturnType<typeof passingReport>) => { r.memory.settled = []; },
      (r: ReturnType<typeof passingReport>) => { r.memory.settled[5].samples.pop(); },
      (r: ReturnType<typeof passingReport>) => { r.memory.settled[5].throughCycle = 50; },
      (r: ReturnType<typeof passingReport>) => { r.memory.settled[5].samples[0].appBytes = NaN; },
    ]) { const r = passingReport(); change(r); expect(assessDesignPerformance(r).passed).toBe(false); }
  });

  it("never treats missing, non-finite or duplicated observations as successful evidence", () => {
    const r = passingReport(); r.idle[0].hiddenCpu = NaN;
    expect(assessDesignPerformance(r).passed).toBe(false);
    const dup = passingReport(); dup.memory.cycles[99].cycle = 99;
    expect(assessDesignPerformance(dup).passed).toBe(false);
    const empty = passingReport(); empty.interactions = [];
    expect(assessDesignPerformance(empty).passed).toBe(false);
    const partial = passingReport(); partial.openings = partial.openings.slice(0, 1);
    expect(assessDesignPerformance(partial).passed).toBe(false);
    const error = { ...passingReport(), cleanupError: "Native app failed to close" };
    expect(assessDesignPerformance(error).passed).toBe(false);
    const stillRunning = { ...passingReport(), runtimeRetired: false };
    expect(assessDesignPerformance(stillRunning).passed).toBe(false);
  });

  it("rejects owner coverage without normal authorization or with Personal-only Local admission", () => {
    const local = passingReport(); local.runtime.localDevelopment = true;
    expect(assessDesignPerformance(local).failures).toContain("owner-authorization");
    const signedOut = passingReport(); signedOut.authorization.signedIn = false;
    expect(assessDesignPerformance(signedOut).failures).toContain("owner-authorization");
    const noMember = passingReport(); noMember.authorization.confirmedOrganization = false;
    expect(assessDesignPerformance(noMember).failures).toContain("owner-authorization");
  });
});
