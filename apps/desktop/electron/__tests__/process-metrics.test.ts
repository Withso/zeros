import { describe, expect, it } from "vitest";

import {
  ProcessMetricsScanCoordinator,
  ProcessMetricsTracker,
  normalizeTerminalRoots,
  parseCpuTime,
  parseFootprint,
  parseProcessArgs,
  parseProcessTable,
  parseSystemSysctl,
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

  it("keeps macOS processes past an hour of CPU, whose ps clock counts minutes without bound", () => {
    // macOS prints accumulated CPU time as MMM:SS.ss. An engine that has used
    // 77 minutes of CPU must not vanish (with every agent below it).
    expect(parseCpuTime("77:46.90")).toBe(4_666.9);
    expect(parseCpuTime("108:33.73")).toBeCloseTo(6_513.73, 5);
    expect(parseCpuTime("1234:05.06")).toBeCloseTo(74_045.06, 5);
    expect(parseCpuTime("01:60.00")).toBeNull();
    expect(parseCpuTime("01:60:00")).toBeNull();

    const rows = parseProcessTable(`
  100     1 47888  83:27.80 Wed Oct 15 11:55:23 2026 /Applications/Zeros.app/Contents/MacOS/Zeros
  300   100 170480  77:35.86 Wed Oct 15 11:55:26 2026 /Applications/Zeros.app/Contents/Resources/zeros-engine
  400   300 25024   0:12.50 Thu Oct 16 10:01:00 2026 /Applications/Zeros.app/Contents/Resources/codex-runtime/vendor/aarch64-apple-darwin/bin/codex
`);
    expect(rows.map((row) => row.pid)).toEqual([100, 300, 400]);

    const tracker = new ProcessMetricsTracker();
    const snapshot = tracker.capture({
      sampledAt: 1_000,
      scanDurationMs: 5,
      appPid: 100,
      enginePid: 300,
      samplerPid: null,
      logicalCpuCount: 10,
      systemMemoryBytes: 16 * 1024 ** 3,
      terminalPids: [],
      terminalRootsKnown: true,
      rows,
      electronProcesses: [{ pid: 100, type: "Browser", creationTime: 1 }],
    });
    expect(snapshot.processes.map((process) => process.pid)).toEqual([
      100, 300, 400,
    ]);
  });
});

describe("ProcessMetricsTracker", () => {
  it("attributes each renderer to its native owner without changing process identity", () => {
    const owners = ["Main window", "Browser tab", "Browser preview", "Design capture", "Agent-control overlay"];
    const input = captureInput(10_000, { main: 0, renderer: 0, sidecar: 0, terminal: 0, terminalChild: 0 });
    input.electronProcesses = owners.map((owner, i) => Object.assign({
      pid: 600 + i, type: "Tab", creationTime: 2_000 + i, workingSetBytes: 200 * KB,
    }, { rendererOwner: owner }));
    const snapshot = new ProcessMetricsTracker().capture(input);
    const renderers = snapshot.processes.filter((row) => row.kind === "renderer");
    console.info("Renderer attribution fixture", { attributed: renderers.filter((row) => row.name !== "Renderer").length });
    expect(renderers.map((row) => row.name)).toEqual(owners.map((owner) => `Renderer — ${owner}`));
    expect(renderers.map((row) => row.id)).toEqual(owners.map((_, i) => `${600 + i}:${2_000 + i}`));
  });

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
    ).toMatchObject({ name: "Engine", kind: "sidecar", parentPid: 100 });
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

describe("Mac context parsing", () => {
  it("reads physical footprint and the PhysMem summary from top", () => {
    const read = parseFootprint(
      `Processes: 392 total, 3 running, 389 sleeping, 2361 threads
CPU usage: 42.28% user, 33.42% sys, 24.28% idle
PhysMem: 15G used (12G wired, 1305M compressor), 159M unused.

PID    MEM
90733  1150M
90831  430M+
99956  6801K
400    1248M-
1      21M
0      10M
`,
      5_000,
    );
    expect(read.readAt).toBe(5_000);
    expect(read.bytesByPid.get(90733)).toBe(1150 * 1024 ** 2);
    expect(read.bytesByPid.get(90831)).toBe(430 * 1024 ** 2);
    expect(read.bytesByPid.get(99956)).toBe(6801 * KB);
    expect(read.bytesByPid.get(400)).toBe(1248 * 1024 ** 2);
    expect(read.physMem).toBe(
      "PhysMem: 15G used (12G wired, 1305M compressor), 159M unused.",
    );
    expect(read.cpuUsage).toContain("24.28% idle");
  });

  it("reads memory pressure, free percentage and swap, leaving unknown keys null", () => {
    expect(
      parseSystemSysctl(`vm.swapusage: total = 7168.00M  used = 6005.31M  free = 1162.69M  (encrypted)
kern.memorystatus_level: 13
kern.memorystatus_vm_pressure_level: 2
`),
    ).toEqual({
      memoryPressure: "warning",
      memoryFreePercent: 13,
      swapUsedBytes: Math.round(6005.31 * 1024 ** 2),
      swapTotalBytes: 7168 * 1024 ** 2,
    });
    expect(parseSystemSysctl("kern.memorystatus_level: \n")).toEqual({
      memoryPressure: null,
      memoryFreePercent: null,
      swapUsedBytes: null,
      swapTotalBytes: null,
    });
  });

  it("keys argv by start time so a reused PID never inherits a command line", () => {
    expect(
      parseProcessArgs(`  300 Wed Oct 15 11:55:26 2026     /Applications/Zeros.app/Contents/Resources/zeros-engine serve --port 24193
  401 Thu Oct  2 09:01:00 2026 node /work/node_modules/vitest/vitest.mjs run
  402 Thu Oct 16 09:01:00 2026
malformed
`),
    ).toEqual([
      {
        pid: 300,
        startKey: "Wed Oct 15 11:55:26 2026",
        args: "/Applications/Zeros.app/Contents/Resources/zeros-engine serve --port 24193",
      },
      {
        pid: 401,
        // Same normalization as parseProcessTable: the padded day collapses.
        startKey: "Thu Oct 2 09:01:00 2026",
        args: "node /work/node_modules/vitest/vitest.mjs run",
      },
      {
        pid: 402,
        startKey: "Thu Oct 16 09:01:00 2026",
        args: "",
      },
    ]);
  });
});

describe("ProcessMetricsTracker roles, footprint and other Zeros apps", () => {
  const APP = "/Applications/Zeros.app/Contents/MacOS/Zeros";
  function input(sampledAt: number, footprintAt?: number): ProcessMetricsCaptureInput {
    return {
      sampledAt,
      scanDurationMs: 4,
      appPid: 100,
      enginePid: 300,
      samplerPid: null,
      logicalCpuCount: 10,
      systemMemoryBytes: 16 * 1024 ** 3,
      terminalPids: [],
      terminalRootsKnown: true,
      appExecutable: APP,
      rows: [
        { pid: 100, parentPid: 1, rssBytes: 100 * KB, cpuTimeSeconds: 1, startKey: "a", command: APP },
        { pid: 300, parentPid: 100, rssBytes: 300 * KB, cpuTimeSeconds: 1, startKey: "b", command: "/Applications/Zeros.app/Contents/Resources/zeros-engine" },
        { pid: 310, parentPid: 300, rssBytes: 10 * KB, cpuTimeSeconds: 1, startKey: "c", command: APP },
        { pid: 320, parentPid: 310, rssBytes: 20 * KB, cpuTimeSeconds: 1, startKey: "d", command: "/Applications/Zeros.app/Contents/Resources/codex-runtime/vendor/aarch64-apple-darwin/bin/codex" },
        { pid: 330, parentPid: 320, rssBytes: 4_000 * KB, cpuTimeSeconds: 1, startKey: "e", command: "node" },
        { pid: 900, parentPid: 1, rssBytes: 50 * KB, cpuTimeSeconds: 1, startKey: "f", command: "/Applications/Zeros Alpha.app/Contents/MacOS/Zeros Alpha" },
        { pid: 901, parentPid: 900, rssBytes: 70 * KB, cpuTimeSeconds: 1, startKey: "g", command: "/Applications/Zeros Alpha.app/Contents/Resources/zeros-engine" },
        { pid: 950, parentPid: 1, rssBytes: 80 * KB, cpuTimeSeconds: 1, startKey: "h", command: "/Applications/Zeroscope.app/Contents/MacOS/Zeroscope" },
      ],
      electronProcesses: [{ pid: 100, type: "Browser", creationTime: 1 }],
      footprint:
        footprintAt == null
          ? null
          : {
              readAt: footprintAt,
              bytesByPid: new Map([
                [100, 400 * KB],
                [330, 9_000 * KB],
                [900, 500 * KB],
              ]),
              physMem: null,
              cpuUsage: null,
            },
    };
  }

  it("labels engine, supervisor, agent and tool rows from argv held in main", () => {
    const tracker = new ProcessMetricsTracker();
    const first = input(1_000);
    expect(tracker.missingArgPids(first)).toEqual([100, 300, 310, 320, 330]);
    tracker.recordArgs([
      { pid: 310, startKey: "c", args: `${APP} /Applications/Zeros.app/Contents/Resources/host-process-supervisor.mjs --pending /x -- codex` },
      { pid: 320, startKey: "d", args: "codex app-server -c mcp_servers.a.url=\"http://127.0.0.1:1/mcp\"" },
      { pid: 330, startKey: "e", args: "node /w/node_modules/.bin/../typescript/bin/tsc --noEmit -p tsconfig.typecheck.json" },
    ]);
    const snapshot = tracker.capture(first);
    const names = Object.fromEntries(
      snapshot.processes.map((process) => [process.pid, [process.name, process.kind]]),
    );
    expect(names).toEqual({
      100: ["Main", "main"],
      300: ["Engine", "sidecar"],
      310: ["Agent supervisor", "helper"],
      320: ["Codex", "agent"],
      330: ["tsc", "process"],
    });
    expect(tracker.missingArgPids(input(2_000))).toEqual([100, 300]);
    // Nothing argv-shaped reaches the renderer snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("tsconfig");
    expect(JSON.stringify(snapshot)).not.toContain("127.0.0.1");
  });

  it("applies physical footprint only to processes that existed when the read started", () => {
    const tracker = new ProcessMetricsTracker();
    tracker.capture(input(1_000));
    const withFootprint = tracker.capture(input(2_000, 1_500));
    expect(withFootprint.memorySource).toBe("footprint");
    expect(withFootprint.footprintAgeMs).toBe(500);
    expect(withFootprint.processes.find((p) => p.pid === 330)?.memoryBytes).toBe(9_000 * KB);
    // No footprint entry: resident size remains.
    expect(withFootprint.processes.find((p) => p.pid === 300)?.memoryBytes).toBe(300 * KB);

    // A process first sampled after the read started cannot borrow its PID's
    // footprint value.
    const fresh = new ProcessMetricsTracker();
    const late = fresh.capture(input(2_000, 1_500));
    expect(late.memorySource).toBe("resident");
    expect(late.processes.find((p) => p.pid === 330)?.memoryBytes).toBe(4_000 * KB);

    // A stale read is ignored entirely.
    const stale = tracker.capture(input(40_000, 1_500));
    expect(stale.memorySource).toBe("resident");
    expect(stale.footprintAgeMs).toBeNull();
  });

  it("totals other Zeros channel apps without counting look-alike bundles", () => {
    const tracker = new ProcessMetricsTracker();
    tracker.capture(input(1_000));
    const next = input(2_000, 1_500);
    next.rows[5].cpuTimeSeconds = 1.5;
    const snapshot = tracker.capture(next);
    expect(snapshot.otherApps).toEqual([
      {
        name: "Zeros Alpha",
        processCount: 2,
        cpuPercent: 50,
        memoryBytes: 500 * KB + 70 * KB,
      },
    ]);
    expect(snapshot.processes.some((process) => process.pid >= 900)).toBe(false);
  });
});
