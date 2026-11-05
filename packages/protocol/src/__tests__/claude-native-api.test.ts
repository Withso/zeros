import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import { Server } from "node:http";
import { join } from "node:path";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { claudeNativeApi } from "./fixtures/claude-native-api";

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

beforeEach(() => { vi.mocked(rm).mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

it("joins a failed spawn without leaving fixture cleanup pending", async () => {
  const fixture = await claudeNativeApi(() => []);
  const child = fixture.spawnClaudeCodeProcess({ command: join(fixture.directory, "missing-native-child"), args: [], cwd: fixture.directory, env: fixture.env, signal: new AbortController().signal });
  const retired = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    const [error] = await once(child, "error");
    expect(error).toMatchObject({ code: "ENOENT" });
    await retired;
  } finally { await fixture.close(); }
  expect(vi.mocked(rm)).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
});

it("closes once and refuses a late process that could recreate the retired tree", async () => {
  const fixture = await claudeNativeApi(() => []), closing = fixture.close();
  expect(fixture.close()).toBe(closing);
  expect(() => fixture.spawnClaudeCodeProcess({ command: process.execPath, args: [], cwd: fixture.directory, env: fixture.env, signal: new AbortController().signal })).toThrow("Native fixture is closing");
  await closing;
  expect(vi.mocked(rm)).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
});

it("keeps the fixture tree until the spawned process has closed", async () => {
  const fixture = await claudeNativeApi(() => []);
  const start = (fixture as typeof fixture & { spawnClaudeCodeProcess?: (options: SpawnOptions) => ChildProcessWithoutNullStreams }).spawnClaudeCodeProcess
    ?? ((options: SpawnOptions) => spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe" }));
  const child = start({ command: process.execPath,
    args: ["-e", "process.stdin.on('data', () => process.exit(0)); process.stdout.write('ready');"],
    cwd: fixture.directory, env: fixture.env, signal: new AbortController().signal });
  const exited = once(child, "close");
  let closeFixture: Promise<void> | undefined;
  try {
    expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
    let serverClosed!: () => void;
    const closed = new Promise<void>(resolve => { serverClosed = resolve; });
    const close = Server.prototype.close;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback?: (error?: Error) => void) {
      return close.call(this, error => { callback?.(error); serverClosed(); });
    });
    closeFixture = fixture.close();
    await closed;
    expect(child.exitCode).toBeNull();
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    child.stdin.end("release");
    await exited;
    await closeFixture;
    expect(vi.mocked(rm)).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
  } finally {
    if (child.exitCode === null) child.stdin.end("release");
    await exited;
    await (closeFixture ?? fixture.close());
  }
});

it.each([false, true])("bounds child retirement without signaling a closed process (stalled=%s)", async stalled => {
  const fixture = await claudeNativeApi(() => []);
  const child = fixture.spawnClaudeCodeProcess({ command: process.execPath,
    args: ["-e", "process.stdin.on('data', () => process.exit(0)); process.stdout.write('ready');"],
    cwd: fixture.directory, env: fixture.env, signal: new AbortController().signal });
  const exited = once(child, "close");
  let closeFixture: Promise<void> | undefined;
  try {
    expect(String((await once(child.stdout, "data"))[0])).toBe("ready");
    const kill = vi.spyOn(child, "kill");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let serverClosed!: () => void;
    const closed = new Promise<void>(resolve => { serverClosed = resolve; });
    const close = Server.prototype.close;
    vi.spyOn(Server.prototype, "close").mockImplementation(function (this: Server, callback?: (error?: Error) => void) {
      return close.call(this, error => { callback?.(error); serverClosed(); });
    });
    closeFixture = fixture.close();
    await closed;
    expect(vi.mocked(rm)).not.toHaveBeenCalled();
    if (!stalled) {
      child.stdin.end("release");
      await exited;
      await closeFixture;
    }
    await vi.advanceTimersByTimeAsync(5_000);
    if (stalled) expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    else expect(kill).not.toHaveBeenCalled();
    await exited;
    await closeFixture;
    expect(vi.mocked(rm)).toHaveBeenCalledExactlyOnceWith(fixture.directory, { recursive: true, force: true });
  } finally {
    vi.useRealTimers();
    if (child.exitCode === null && child.signalCode === null) child.stdin.end("release");
    await exited;
    await (closeFixture ?? fixture.close());
  }
});
