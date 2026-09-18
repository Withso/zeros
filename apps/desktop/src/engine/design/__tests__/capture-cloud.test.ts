import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const launch = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: launch }));
import { createCloudDesignCaptureHost } from "../capture-cloud";
const input = {
  version: 1 as const,
  html: "<body>Fixture</body>",
  revision: "revision",
  width: 1,
  height: 1,
  colorScheme: "light" as const,
};
function child() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("runs under a separate UID with no inherited provider or capture authority", async () => {
  const worker = child();
  launch.mockReturnValue(worker);
  vi.spyOn(process, "kill").mockReturnValue(true);
  const promise = createCloudDesignCaptureHost()(
    input,
    new AbortController().signal,
  );
  expect(launch.mock.calls.at(-1)?.[1]).toContain("--reuid=10002");
  expect(launch.mock.calls.at(-1)?.[1]).toContain("--clear-groups");
  expect(Object.keys(launch.mock.calls.at(-1)?.[2].env).sort()).toEqual([
    "HOME",
    "LANG",
    "PATH",
    "PLAYWRIGHT_BROWSERS_PATH",
  ]);
  worker.stdout.emit(
    "data",
    Buffer.from(
      JSON.stringify({
        data: Buffer.from("png").toString("base64"),
        renderer: "fixture",
      }),
    ),
  );
  worker.emit("close", 0);
  expect(await promise).toEqual({
    bytes: Buffer.from("png"),
    renderer: "fixture",
  });
});
it("cancels the entire worker group and escalates if graceful browser cleanup hangs", async () => {
  vi.useFakeTimers();
  const worker = child();
  launch.mockReturnValue(worker);
  const kill = vi.spyOn(process, "kill").mockReturnValue(true);
  const abort = new AbortController();
  const promise = createCloudDesignCaptureHost()(input, abort.signal).catch(
    (error) => error,
  );
  abort.abort();
  expect(kill).toHaveBeenCalledWith(-424242, "SIGTERM");
  await vi.advanceTimersByTimeAsync(1000);
  expect(kill).toHaveBeenCalledWith(-424242, "SIGKILL");
  worker.emit("close", null);
  expect(await promise).toBeInstanceOf(Error);
  expect(vi.getTimerCount()).toBe(0);
});
