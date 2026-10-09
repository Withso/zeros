import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { qualifyCloudEngineCommand } from "../cloud-workspace-validation/sandbox/qualify-cloud-engine.mjs";
import type { CloudQualificationRuntime } from "../cloud-workspace-validation/sandbox/cloud-qualification-runtime";

// Explicit launch/transport ports; this suite proves ordering/refusals, not
// native cgroup entry or authority in a deployed VM.
const prepare = vi.fn(), spawn = vi.fn(), stop = vi.fn(), wait = vi.fn();
const context = { boundary: { prepare } } as unknown as CloudQualificationRuntime;
const runtime = { binRoot: "/opt/fixture/bin" };
let controller: AbortController;
beforeEach(() => {
  controller = new AbortController();
  for (const mock of [prepare, spawn, stop, wait]) mock.mockReset();
  prepare.mockResolvedValue({ spawn, stopAndProve: stop });
  spawn.mockResolvedValue({ stdout: new PassThrough(), stderr: new PassThrough(), wait });
  wait.mockResolvedValue({ code: 0, signal: null });
  stop.mockResolvedValue(undefined);
});
const command = () => qualifyCloudEngineCommand(context, runtime, "/usr/bin/nsenter", ["--target", "1"], controller.signal);
it("reserves and launches every target through the original boundary before reading its exit", async () => {
  await expect(command()).resolves.toBe(true);
  expect(prepare).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actor: "repo-code-task",
    cwd: "/srv/zeros/workspace", workspaceRoot: "/srv/zeros/workspace", providerId: "engine-qualification" }), { signal: controller.signal });
  expect(spawn).toHaveBeenCalledExactlyOnceWith({ command: "/usr/bin/nsenter", args: ["--target", "1"],
    cwd: "/srv/zeros/workspace", env: { PATH: "/opt/fixture/bin:/usr/bin:/bin", HOME: "/tmp" }, stdio: "pipe" });
  expect(prepare.mock.invocationCallOrder[0]).toBeLessThan(spawn.mock.invocationCallOrder[0]!);
  expect(spawn.mock.invocationCallOrder[0]).toBeLessThan(wait.mock.invocationCallOrder[0]!);
  expect(stop).toHaveBeenCalledOnce();
});
it("retains an actual nonzero target exit for negative authority checks", async () => {
  wait.mockResolvedValue({ code: 1, signal: null });
  await expect(command()).resolves.toBe(false); expect(stop).toHaveBeenCalledOnce();
});
it("awaits original group retirement before accepting target success", async () => {
  let release!: () => void;
  stop.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
  let completed = false;
  const pending = command().then(value => { completed = true; return value; });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(completed).toBe(false); release(); await expect(pending).resolves.toBe(true);
});
it.each([0, 1])("never treats failed retirement as a successful authority check after exit%s", async code => {
  wait.mockResolvedValue({ code, signal: null }); stop.mockRejectedValue(new Error("fixture retirement refused"));
  await expect(command()).rejects.toThrow();
});
it("retires an owned preparation after launch refusal without inventing a target exit", async () => {
  spawn.mockRejectedValue(new Error("fixture launch refused"));
  await expect(command()).rejects.toThrow(); expect(stop).toHaveBeenCalledOnce(); expect(wait).not.toHaveBeenCalled();
});
it("refuses a failed original preparation before target launch", async () => {
  prepare.mockRejectedValue(new Error("fixture preparation refused"));
  await expect(command()).rejects.toThrow(); expect(spawn).not.toHaveBeenCalled();
});
it("does not reserve after an original timeout is already aborted", async () => {
  controller.abort(); await expect(command()).rejects.toThrow(); expect(prepare).not.toHaveBeenCalled();
});
it("does not use timeout retirement as evidence the target operation was denied", async () => {
  wait.mockImplementation(async () => { controller.abort(); return { code: 0, signal: null }; });
  await expect(command()).rejects.toThrow(); expect(stop).toHaveBeenCalledOnce();
});
it.each([{ code: null, signal: "SIGKILL" }, { code: null, signal: null }, { code: 0, signal: "SIGTERM" }])(
  "refuses missing or signal-terminated target results %j", async exit => {
    wait.mockResolvedValue(exit); await expect(command()).rejects.toThrow(); expect(stop).toHaveBeenCalledOnce();
  });
