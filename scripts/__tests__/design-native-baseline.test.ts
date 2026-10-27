import { describe, expect, it, vi } from "vitest";
import { assertNativeMemoryBudget, findNativeDesignFixture, nativeCpuSeconds, nativeDesignEndpoint, parseNativePhysicalFootprints, parseNativeOwnedFootprints, readNativePhysicalFootprints, processMemory } from "../design-native-baseline.mjs";

describe("native Design fixture discovery", () => {
  const page = (count: () => Promise<number>, closed = () => false) => ({
    isClosed: closed,
    locator: vi.fn(() => ({ count })),
  });
  const browser = (...pages: ReturnType<typeof page>[]) => ({ contexts: () => [{ pages: () => pages }] });

  it("keeps the app fixture when a disposable capture closes during discovery", async () => {
    let closed = false;
    const capture = page(async () => {
      closed = true;
      throw new Error("Target page, context or browser has been closed");
    }, () => closed);
    const fixture = page(async () => 1);
    await expect(findNativeDesignFixture(browser(capture, fixture))).resolves.toBe(fixture);
  });

  it("does not query an already retired native capture", async () => {
    const capture = page(vi.fn(async () => { throw new Error("Page is closed"); }), () => true);
    const fixture = page(async () => 1);
    await expect(findNativeDesignFixture(browser(capture, fixture))).resolves.toBe(fixture);
    expect(capture.locator).not.toHaveBeenCalled();
  });

  it("preserves failures from a live fixture", async () => {
    const fixture = page(async () => { throw new Error("Renderer inspection failed"); });
    await expect(findNativeDesignFixture(browser(fixture))).rejects.toThrow("Renderer inspection failed");
  });

  it("requires exactly one live visible fixture", async () => {
    await expect(findNativeDesignFixture(browser(page(async () => 0)))).rejects.toThrow("exactly one");
    await expect(findNativeDesignFixture(browser(page(async () => 1), page(async () => 1)))).rejects.toThrow("exactly one");
  });
});

describe("native Design measurement endpoint", () => {
  it("accepts explicit loopback debugging endpoints", () => {
    expect(nativeDesignEndpoint("http://127.0.0.1:9222")).toBe("http://127.0.0.1:9222");
    expect(nativeDesignEndpoint("http://[::1]:9222")).toBe("http://[::1]:9222");
  });
  it.each(["https://127.0.0.1:9222", "http://127.example.com:9222", "http://example.com:9222", "http://a:b@127.0.0.1:9222", "http://127.0.0.1:9222/?secret=1", "http://127.0.0.1:9222/json"]) (
    "refuses a foreign or credential-bearing endpoint %s", (endpoint) => {
      expect(() => nativeDesignEndpoint(endpoint)).toThrow();
    },
  );
});

it("records OS CPU time for a standalone engine process absent from Chromium metrics", async () => {
  const [sample] = await processMemory([{ id: process.pid, type: "local-engine" }]);
  expect(typeof sample.cpuSeconds).toBe("number");
  expect(sample.cpuSeconds).toBeGreaterThanOrEqual(0);
  expect(sample.rssBytes).toBeGreaterThan(0);
});

it.each([
  ["00:00.00", 0], ["02:03.45", 123.45], ["123:45.6", 7425.6],
  ["02:03:04", 7384], ["1-02:03:04.5", 93784.5],
])("reads cumulative process CPU time %s", (value, seconds) => {
  expect(nativeCpuSeconds(value)).toBe(seconds);
});

it.each(["", "unknown", "-01:00", "00:60", "01:60:00", "1-24:00:00", "1-02:00"])(
  "preserves unavailable or invalid CPU time %s as missing", value => {
    expect(nativeCpuSeconds(value)).toBeNull();
  },
);

describe("native graphics memory acceptance", () => {
  const MiB = 1024 ** 2;
  const limits = { maxGpuBytes: 1536 * MiB, maxTotalBytes: 3072 * MiB };
  const rows = () => [
    { pid: 101, role: "Browser", rssBytes: 120 * MiB, physicalFootprintBytes: 220 * MiB },
    { pid: 102, role: "GPU", rssBytes: 123 * MiB, physicalFootprintBytes: 500 * MiB },
    { pid: 103, role: "renderer", rssBytes: 300 * MiB, physicalFootprintBytes: 680 * MiB },
  ];

  it("samples only owned processes without substituting RSS for an unavailable native reading", async () => {
    const response = { source: "proc_pid_rusage", version: 1, rows: [
      { pid: 101, physicalFootprintBytes: 15 * 1024 ** 3, error: null },
      { pid: 102, physicalFootprintBytes: null, error: 3 },
    ] };
    const run = vi.fn(async () => ({ stdout: JSON.stringify(response) }));
    expect([...await readNativePhysicalFootprints([101, 102], { platform: "darwin", run })]).toEqual([[101, 15 * 1024 ** 3]]);
    expect(run).toHaveBeenCalledWith("/usr/bin/python3", [expect.stringMatching(/design-native-footprint\.py$/), "[101,102]"], expect.objectContaining({ timeout: 5000 }));
    await expect(readNativePhysicalFootprints([101, 101], { platform: "darwin", run })).rejects.toThrow("owned process identities");
    await expect(readNativePhysicalFootprints([], { platform: "darwin", run })).rejects.toThrow("owned process identities");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("rejects partial, duplicate, foreign or invalid physical-memory responses", () => {
    const valid = { pid: 101, physicalFootprintBytes: 100 * MiB, error: null };
    const response = (rows: unknown[]) => JSON.stringify({ source: "proc_pid_rusage", version: 1, rows });
    expect(() => parseNativeOwnedFootprints(response([]), [101])).toThrow("incomplete");
    expect(() => parseNativeOwnedFootprints(response([valid, valid]), [101, 102])).toThrow("identity mismatch");
    expect(() => parseNativeOwnedFootprints(response([{ ...valid, pid: 200 }]), [101])).toThrow("identity mismatch");
    expect(() => parseNativeOwnedFootprints(response([{ ...valid, physicalFootprintBytes: null }]), [101])).toThrow("invalid");
    expect(() => parseNativeOwnedFootprints(response([{ ...valid, physicalFootprintBytes: -1 }]), [101])).toThrow("invalid");
    expect(() => parseNativeOwnedFootprints(response([{ ...valid, error: 1 }]), [101])).toThrow("invalid");
  });

  it("reads macOS physical footprints, including large compressed/GPU values and delta markers", () => {
    const values = parseNativePhysicalFootprints("Processes: 500 total\nPID MEM\n101 220M\n102 15.00G+\n103 512K-\n104 16B\n105 ???\n106 1e9G\n");
    expect([...values]).toEqual([[101, 220 * MiB], [102, 15 * 1024 ** 3], [103, 512 * 1024], [104, 16]]);
  });

  it("rejects the reported GPU allocation even when RSS looks small", () => {
    const samples = rows();
    samples[1].physicalFootprintBytes = 15 * 1024 ** 3;
    expect(() => assertNativeMemoryBudget(samples, limits)).toThrow("GPU physical footprint");
  });

  it("rejects an aggregate app overrun with individually small processes", () => {
    const samples = rows();
    samples[2].physicalFootprintBytes = 2600 * MiB;
    expect(() => assertNativeMemoryBudget(samples, limits)).toThrow("App physical footprint");
  });

  it("never substitutes resident memory for an unavailable footprint", () => {
    const samples = rows().map(row => ({ ...row, physicalFootprintBytes: row.role === "GPU" ? null : row.physicalFootprintBytes }));
    expect(() => assertNativeMemoryBudget(samples, limits)).toThrow("physical footprint is unavailable");
  });

  it("requires the GPU process and rejects duplicate process samples", () => {
    expect(() => assertNativeMemoryBudget(rows().filter(row => row.role !== "GPU"), limits)).toThrow("GPU process");
    expect(() => assertNativeMemoryBudget([...rows(), rows()[1]], limits)).toThrow("Duplicate");
  });

  it("accepts bounded physical memory without treating process RSS as the budget", () => {
    const samples = rows();
    samples[1].rssBytes = 16 * 1024 ** 3;
    expect(assertNativeMemoryBudget(samples, limits)).toEqual({ gpuBytes: 500 * MiB, totalBytes: 1400 * MiB });
  });
});
