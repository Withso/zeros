import { describe, expect, it, vi } from "vitest";
import { editAlphaRelease } from "./alpha-release-edit";

const input = { repository: "fixture/zeros", sha: "a".repeat(40), title: "Zeros Alpha v0.1.0-alpha.123",
  notes: "Literal `notes` with $(text)\nand a second line." };
const serverError = (status = 500, message = "") => Object.assign(new Error("private subprocess error"), {
  code: 1, killed: false, signal: null,
  stderr: `HTTP ${status}${message} (https://api.github.com/repos/fixture/zeros/releases/123)\n`,
});
function fixture(failures: unknown[]) {
  const pending = [...failures];
  const run = vi.fn(async (_args: readonly string[], _signal?: AbortSignal) => {
    if (pending.length) throw pending.shift();
  });
  return { run, wait: vi.fn(async (_milliseconds: number, _signal?: AbortSignal) => {}), report: vi.fn() };
}

describe("bounded Alpha release metadata edit", () => {
  it("retries only identical metadata, with bounded backoff and closed diagnostics", async () => {
    const ports = fixture([serverError(), serverError(502, ": private gateway detail")]);
    await editAlphaRelease(input, undefined, ports);
    expect(ports.run).toHaveBeenCalledTimes(3);
    expect(ports.wait.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1000, 2000]);
    for (const [args] of ports.run.mock.calls) expect(args).toEqual(["release", "edit", "alpha", "--repo", input.repository,
      "--prerelease", "--title", input.title, "--notes", input.notes, "--target", input.sha]);
    expect(ports.report.mock.calls).toEqual([["Alpha release edit returned HTTP 500 (attempt 1/3)."],
      ["Alpha release edit returned HTTP 502 (attempt 2/3)."]]);
    expect(JSON.stringify(ports.report.mock.calls)).not.toContain("private");
  });

  it("stops after the third server failure", async () => {
    const ports = fixture([serverError(503), serverError(504), serverError(500), serverError()]);
    await expect(editAlphaRelease(input, undefined, ports)).rejects.toThrow("publication stopped");
    expect(ports.run).toHaveBeenCalledTimes(3);
    expect(ports.wait).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 408, 422, 429])("does not retry HTTP %i", async status => {
    const ports = fixture([serverError(status)]);
    await expect(editAlphaRelease(input, undefined, ports)).rejects.toThrow("publication stopped");
    expect(ports.run).toHaveBeenCalledTimes(1);
    expect(ports.wait).not.toHaveBeenCalled();
    expect(ports.report).not.toHaveBeenCalled();
  });

  it.each([
    new Error("private defect"),
    { ...serverError(), code: "ENOENT" },
    { ...serverError(), code: 2 },
    { ...serverError(), killed: true },
    { ...serverError(), signal: "SIGTERM" },
    { ...serverError(), stderr: "HTTP 500" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/foreign/zeros/releases/123)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/fixture/zeros-extra/releases/123)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/foreign/../fixture/zeros/releases/123)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/fixture/zeros/releases/tags/alpha)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/fixture/zeros/releases/123/assets)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://foreign.invalid/repos/fixture/zeros/releases/123)\n" },
    { ...serverError(), stderr: "HTTP 500 (https://api.github.com/repos/fixture/zeros/releases/123?private=value)\n" },
    { ...serverError(), stderr: `${serverError().stderr}private extra output\n` },
  ])("keeps an unknown, foreign or cancelled subprocess failure terminal (%#)", async error => {
    const ports = fixture([error]);
    await expect(editAlphaRelease(input, undefined, ports)).rejects.toThrow("Private diagnostics withheld");
    expect(ports.run).toHaveBeenCalledTimes(1);
    expect(ports.wait).not.toHaveBeenCalled();
    expect(ports.report).not.toHaveBeenCalled();
  });

  it("does not start a cancelled edit", async () => {
    const ports = fixture([]), controller = new AbortController();
    controller.abort(new Error("private cancellation reason"));
    await expect(editAlphaRelease(input, controller.signal, ports)).rejects.toThrow("edit cancelled");
    expect(ports.run).not.toHaveBeenCalled();
  });

  it("does not retry when cancellation races a server failure", async () => {
    const ports = fixture([]), controller = new AbortController();
    ports.run.mockImplementation(async (_args, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw serverError();
    });
    await expect(editAlphaRelease(input, controller.signal, ports)).rejects.toThrow("edit cancelled");
    expect(ports.run).toHaveBeenCalledTimes(1);
    expect(ports.wait).not.toHaveBeenCalled();
  });

  it("checks cancellation again after backoff even if a wait returns normally", async () => {
    const ports = fixture([serverError()]), controller = new AbortController();
    ports.wait.mockImplementation(async (_milliseconds, signal) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
    });
    await expect(editAlphaRelease(input, controller.signal, ports)).rejects.toThrow("edit cancelled");
    expect(ports.run).toHaveBeenCalledTimes(1);
  });

  it("does not treat a late edit acknowledgement as success after cancellation", async () => {
    const ports = fixture([]), controller = new AbortController();
    ports.run.mockImplementation(async () => { controller.abort(); });
    await expect(editAlphaRelease(input, controller.signal, ports)).rejects.toThrow("edit cancelled");
    expect(ports.run).toHaveBeenCalledTimes(1);
    expect(ports.wait).not.toHaveBeenCalled();
  });

  it("keeps a failed backoff terminal without exposing its error", async () => {
    const ports = fixture([serverError()]);
    ports.wait.mockRejectedValue(new Error("private timer error"));
    await expect(editAlphaRelease(input, undefined, ports)).rejects.toThrow("backoff failed; publication stopped");
    expect(ports.run).toHaveBeenCalledTimes(1);
  });
});
