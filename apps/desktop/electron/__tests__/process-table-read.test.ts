import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), execFile: native.exec }));
import { readProcessTable } from "../process-metrics";

beforeEach(() => { native.exec.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("bounded process-table reads", () => {
  it("allows a bounded on-demand scan to finish on a busy host", async () => {
    native.exec.mockImplementation((_file, _args, _options, callback) => {
      delete _options.env;
      void Promise.resolve().then(() => callback(null, "100 1 1024 00:01.00 Thu Jan 1 00:00:00 2026 Zeros\n", ""));
      return { pid: 999 };
    });
    const result = await readProcessTable();
    expect(result.rows).toHaveLength(1);
    expect(result.samplerPid).toBe(999);
    expect(native.exec.mock.calls[0]?.[2]?.timeout).toBe(5_000);
    expect(native.exec.mock.calls[0]?.[2]?.maxBuffer).toBe(4 * 1024 * 1024);
  });

  it.each([
    [{ killed: true, signal: "SIGTERM" }, "timeout"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGTERM" }, "output-limit"],
    [{ code: 1, killed: false }, "exit"],
    [{ code: "ENOENT", killed: false }, "spawn"],
    [{ signal: "SIGKILL", killed: false }, "signal"],
  ])("reports closed failure evidence without process output: %j", async (fields, reason) => {
    native.exec.mockImplementation((_file, _args, _options, callback) => {
      delete _options.env;
      void Promise.resolve().then(() => callback(Object.assign(new Error("private command output"), fields), "private stdout", "private stderr"));
      return { pid: 999 };
    });
    const error = await readProcessTable().catch((failure: unknown) => failure) as Error;
    expect(error).toMatchObject({ reason, stdoutBytes: 14, stderrBytes: 14 });
    expect(error.message).toContain(reason);
    expect(error.message).not.toContain("private");
  });

  it("refuses an empty successful read instead of reporting an empty process tree", async () => {
    native.exec.mockImplementation((_file, _args, _options, callback) => {
      delete _options.env;
      void Promise.resolve().then(() => callback(null, "", ""));
      return { pid: 999 };
    });
    await expect(readProcessTable()).rejects.toMatchObject({ reason: "invalid-output" });
  });
});
