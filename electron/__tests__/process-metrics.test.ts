import { describe, expect, it } from "vitest";

import {
  ProcessMetricsScanCoordinator,
  ProcessMetricsTracker,
  normalizeTerminalRoots,
  parseCpuTime,
  parseProcessTable,
  type ProcessMetricsCaptureInput,
} from "../process-metrics";

const KB = 1024;

function captureInput(
  sampledAt: number,
  cpuTimes: {
    main: number;
    renderer: number;
    sidecar: number;
    terminal: number;
    terminalChild: number;
  },
): ProcessMetricsCaptureInput {
  return {
    sampledAt,
    scanDurationMs: 12,
    appPid: 100,
    enginePid: 300,
    samplerPid: 999,
    logicalCpuCount: 8,
    systemMemoryBytes: 16 * 1024 ** 3,
    terminalPids: [400],
    terminalRootsKnown: true,
    rows: [
      {
        pid: 100,
        parentPid: 1,
        rssBytes: 100 * KB,
        cpuTimeSeconds: cpuTimes.main,
        startKey: "Sat Aug  1 20:00:00 2026",
        command: "/Applications/Zeros.app/Contents/MacOS/Zeros",
      },
      {
        pid: 200,
        parentPid: 100,
        rssBytes: 200 * KB,
        cpuTimeSeconds: cpuTimes.renderer,
        startKey: "Sat Aug  1 20:00:01 2026",
        command: "Zeros Helper (Renderer)",
      },
      {
        pid: 300,
        parentPid: 100,
        rssBytes: 300 * KB,
        cpuTimeSeconds: cpuTimes.sidecar,
        startKey: "Sat Aug  1 20:00:02 2026",
        command: "zeros-engine",
      },
      {
        pid: 400,
        parentPid: 300,
        rssBytes: 400 * KB,
        cpuTimeSeconds: cpuTimes.terminal,
        startKey: "Sat Aug  1 20:00:03 2026",
        command: "zsh",
      },
      {
        pid: 401,
        parentPid: 400,
        rssBytes: 500 * KB,
        cpuTimeSeconds: cpuTimes.terminalChild,
        startKey: "Sat Aug  1 20:00:04 2026",
        command: "node",
      },
      // The sampler is transient instrumentation, not a live app resource.
      {
        pid: 999,
        parentPid: 100,
        rssBytes: 50 * KB,
        cpuTimeSeconds: 0.01,
        startKey: "Sat Aug  1 20:00:05 2026",
        command: "ps",
      },
      // A same-name process outside the app tree must never leak into totals.
      {
        pid: 777,
        parentPid: 1,
        rssBytes: 900 * KB,
        cpuTimeSeconds: 99,
        startKey: "Sat Aug  1 19:00:00 2026",
        command: "node",
      },
    ],
    electronProcesses: [
      {
        pid: 100,
        type: "Browser",
        creationTime: 1_000,
        workingSetBytes: 110 * KB,
      },
      {
        pid: 200,
        type: "Tab",
        creationTime: 2_000,
        workingSetBytes: 220 * KB,
      },
    ],
  };
}

describe("process metrics parsing", () => {
  it("parses portable ps rows without losing executable names that contain spaces", () => {
    const rows = parseProcessTable(`
  100     1  2048 01:02.34 Sat Aug  1 21:29:41 2026 /Applications/Zeros Dev.app/Contents/MacOS/Zeros Dev
  200   100  4096 2-03:04:05.50 Fri Jul 31 08:01:02 2026 Zeros Helper (Renderer)
malformed row
`);

    expect(rows).toEqual([
      {
        pid: 100,
        parentPid: 1,
        rssBytes: 2048 * KB,
        cpuTimeSeconds: 62.34,
        startKey: "Sat Aug 1 21:29:41 2026",
        command: "/Applications/Zeros Dev.app/Contents/MacOS/Zeros Dev",
      },
      {
        pid: 200,
        parentPid: 100,
        rssBytes: 4096 * KB,
        cpuTimeSeconds: 183_845.5,
        startKey: "Fri Jul 31 08:01:02 2026",
        command: "Zeros Helper (Renderer)",
      },
    ]);
  });

  it("rejects an incomplete terminal-root key instead of claiming exact exclusion", () => {
    expect(normalizeTerminalRoots([101, 202, 101], true)).toEqual({
      terminalPids: [101, 202],
      terminalRootsKnown: true,
    });
    expect(normalizeTerminalRoots([101, "202"], true)).toEqual({
      terminalPids: [101],
      terminalRootsKnown: false,
    });
    expect(
      normalizeTerminalRoots(
        Array.from({ length: 257 }, (_, index) => index + 1),
        true,
      ).terminalRootsKnown,
    ).toBe(false);
  });

  it("accepts the cumulative CPU time formats emitted by BSD and GNU ps", () => {
    expect(parseCpuTime("00:00:01")).toBe(1);
    expect(parseCpuTime("01:02.34")).toBe(62.34);
    expect(parseCpuTime("03:04:05.5")).toBe(11_045.5);
    expect(parseCpuTime("2-03:04:05.50")).toBe(183_845.5);
    expect(parseCpuTime("not-a-time")).toBeNull();
  });
});

describe("ProcessMetricsTracker", () => {
  it("accounts for the exact app tree, logical Electron parents, PTY subtrees, and sampled peaks", () => {
    const tracker = new ProcessMetricsTracker();
    const first = tracker.capture(
      captureInput(10_000, {
        main: 10,
        renderer: 20,
        sidecar: 30,
        terminal: 40,
        terminalChild: 50,
      }),
    );

    expect(first.cpuReady).toBe(false);
    expect(first.processes.map((process) => process.pid)).toEqual([
      100, 200, 300, 400, 401,
    ]);
    expect(
      first.processes.find((process) => process.pid === 100),
    ).toMatchObject({ name: "Main", kind: "main", parentPid: null });
    expect(
      first.processes.find((process) => process.pid === 200),
    ).toMatchObject({ name: "Renderer", kind: "renderer", parentPid: null });
    expect(
      first.processes.find((process) => process.pid === 300),
    ).toMatchObject({ name: "Sidecar", kind: "sidecar", parentPid: 100 });
    expect(
      first.processes.find((process) => process.pid === 400)?.terminal,
    ).toBe(true);
    expect(
      first.processes.find((process) => process.pid === 401)?.terminal,
    ).toBe(true);

    const second = tracker.capture(
      captureInput(11_000, {
        main: 10.5,
        renderer: 20.25,
        sidecar: 30.2,
        terminal: 40.1,
        terminalChild: 50.05,
      }),
    );

    expect(second.cpuReady).toBe(true);
    expect(second.samplingIntervalMs).toBe(1_000);
    expect(second.totals.all).toMatchObject({
      cpuPercent: 110,
      memoryBytes: (110 + 220 + 300 + 400 + 500) * KB,
      peakCpuPercent: 110,
      peakCpuAt: 11_000,
      processCount: 5,
    });
    expect(second.totals.excludingTerminals).toMatchObject({
      cpuPercent: 95,
      memoryBytes: (110 + 220 + 300) * KB,
      peakCpuPercent: 95,
      processCount: 3,
    });

    const thirdInput = captureInput(12_000, {
      main: 10.6,
      renderer: 20.3,
      sidecar: 30.25,
      terminal: 40.15,
      terminalChild: 50.06,
    });
    thirdInput.rows[2].rssBytes = 600 * KB;
    const third = tracker.capture(thirdInput);

    expect(third.totals.all.cpuPercent).toBeCloseTo(26, 5);
    expect(third.totals.all.peakCpuPercent).toBe(110);
    expect(third.totals.all.peakCpuAt).toBe(11_000);
    expect(third.totals.all.peakMemoryBytes).toBe(
      (110 + 220 + 600 + 400 + 500) * KB,
    );
    expect(third.totals.all.peakMemoryAt).toBe(12_000);
  });

  it("does not invent an excluding-terminal peak until PTY ownership is authoritative", () => {
    const tracker = new ProcessMetricsTracker();
    const unknown = captureInput(10_000, {
      main: 1,
      renderer: 1,
      sidecar: 1,
      terminal: 1,
      terminalChild: 1,
    });
    unknown.terminalRootsKnown = false;

    expect(tracker.capture(unknown).totals.excludingTerminals).toBeNull();

    const known = captureInput(11_000, {
      main: 1.1,
      renderer: 1.1,
      sidecar: 1.1,
      terminal: 2,
      terminalChild: 2,
    });
    const snapshot = tracker.capture(known);
    expect(snapshot.totals.excludingTerminals?.memoryBytes).toBe(
      (110 + 220 + 300) * KB,
    );
  });

  it("prefers Chromium's interval CPU while retaining OS RSS when Electron omits memory", () => {
    const tracker = new ProcessMetricsTracker();
    const first = captureInput(10_000, {
      main: 1,
      renderer: 1,
      sidecar: 1,
      terminal: 1,
      terminalChild: 1,
    });
    first.electronProcesses[0].cpuPercent = 0;
    first.electronProcesses[1].cpuPercent = 0;
    delete first.electronProcesses[1].workingSetBytes;
    tracker.capture(first);

    const second = captureInput(11_000, {
      main: 1.9,
      renderer: 1.9,
      sidecar: 1,
      terminal: 1,
      terminalChild: 1,
    });
    second.electronProcesses[0].cpuPercent = 7.25;
    second.electronProcesses[1].cpuPercent = 3.5;
    delete second.electronProcesses[1].workingSetBytes;
    const snapshot = tracker.capture(second);

    expect(
      snapshot.processes.find((process) => process.pid === 100),
    ).toMatchObject({ cpuPercent: 7.25, memoryBytes: 110 * KB });
    expect(
      snapshot.processes.find((process) => process.pid === 200),
    ).toMatchObject({ cpuPercent: 3.5, memoryBytes: 200 * KB });
  });

  it("resets a reused PID and a stale CPU baseline instead of reporting a false spike", () => {
    const tracker = new ProcessMetricsTracker();
    tracker.capture(
      captureInput(1_000, {
        main: 10,
        renderer: 10,
        sidecar: 10,
        terminal: 10,
        terminalChild: 10,
      }),
    );

    const reused = captureInput(2_000, {
      main: 10.1,
      renderer: 10.1,
      sidecar: 10.1,
      terminal: 10.1,
      terminalChild: 0.01,
    });
    // Same executable and a monotonic CPU clock are not enough to identify a
    // process: a PID can exit and be reused between samples.
    reused.rows[4].startKey = "Sat Aug  1 20:00:59 2026";
    reused.rows[4].cpuTimeSeconds = 20;
    const reusedSnapshot = tracker.capture(reused);
    const reusedProcess = reusedSnapshot.processes.find(
      (process) => process.pid === 401,
    );
    expect(reusedProcess?.cpuPercent).toBe(0);
    expect(reusedProcess?.name).toBe("node");

    const stale = tracker.capture(
      captureInput(30_000, {
        main: 30,
        renderer: 30,
        sidecar: 30,
        terminal: 30,
        terminalChild: 30,
      }),
    );
    expect(stale.cpuReady).toBe(false);
    expect(stale.totals.all.cpuPercent).toBe(0);
  });

  it("ignores a CPU delta measured over an implausibly short interval", () => {
    const tracker = new ProcessMetricsTracker();
    const idle = { sidecar: 10, terminal: 10, terminalChild: 10 };
    tracker.capture(captureInput(1_000, { main: 10, renderer: 10, ...idle }));

    // A burst re-sample (a visibility flip landing on top of a scheduled read)
    // divides a centisecond-resolution clock by a near-zero window.
    const burst = tracker.capture(
      captureInput(1_040, { main: 10.02, renderer: 10, ...idle }),
    );
    expect(burst.cpuReady).toBe(false);
    expect(burst.totals.all.cpuPercent).toBe(0);
    // A rejected sample must not record a peak from the bogus rate either.
    expect(burst.totals.all.peakCpuPercent).toBe(0);

    // The normal cadence still reports, measured from the burst sample.
    const settled = tracker.capture(
      captureInput(2_040, { main: 11, renderer: 10, ...idle }),
    );
    expect(settled.cpuReady).toBe(true);
    expect(settled.totals.all.cpuPercent).toBeGreaterThan(0);
  });
});

describe("ProcessMetricsScanCoordinator", () => {
  it("deduplicates concurrent reads and applies the newest exact ownership input", async () => {
    let release!: () => void;
    let scans = 0;
    const coordinator = new ProcessMetricsScanCoordinator(
      { terminalPids: [1] },
      async (latest) => {
        scans += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return latest();
      },
    );

    const first = coordinator.request({ terminalPids: [2] });
    const second = coordinator.request({ terminalPids: [3] });
    expect(second).toBe(first);
    expect(scans).toBe(1);

    release();
    await expect(first).resolves.toEqual({ terminalPids: [3] });

    const third = coordinator.request({ terminalPids: [4] });
    expect(scans).toBe(2);
    release();
    await expect(third).resolves.toEqual({ terminalPids: [4] });
  });
});
