import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
const launch = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: launch }));
import { createCloudDesignCaptureHost } from "../capture-cloud";
import { resolveCloudRuntime } from "../../agents/containment/cloud-runtime-root.mjs";
vi.mock("../../agents/containment/cloud-runtime-root.mjs",async original=>{
  const actual=await original<typeof import("../../agents/containment/cloud-runtime-root.mjs")>();
  return {...actual,resolveCloudRuntime:vi.fn((await import("../../agents/__tests__/helpers/test-cloud-runtime")).testCloudRuntime)};
});
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
  vi.mocked(resolveCloudRuntime).mockReset();
  vi.useRealTimers();
});
it("uses the pinned v4 Node, worker and browser cache for the separate capture UID",async()=>{
  const root=`/opt/zeros-infra/r1-${"a".repeat(64)}`;
  vi.mocked(resolveCloudRuntime).mockReturnValue({...resolveCloudRuntime(),profile:"v4",root,workerRoot:`${root}/worker`,node:`${root}/bin/node`} as ReturnType<typeof resolveCloudRuntime>);
  const worker=child();launch.mockReturnValue(worker);vi.spyOn(process,"kill").mockReturnValue(true);
  const promise=createCloudDesignCaptureHost()(input,new AbortController().signal);
  expect(launch.mock.calls.at(-1)?.[1].slice(-2)).toEqual([`${root}/bin/node`,`${root}/worker/dist-engine/design-capture-worker.js`]);
  expect(launch.mock.calls.at(-1)?.[2].env.PLAYWRIGHT_BROWSERS_PATH).toBe(`${root}/worker/design-browsers`);
  worker.stdout.emit("data",Buffer.from(JSON.stringify({data:Buffer.from("png").toString("base64"),renderer:"fixture"})));
  worker.emit("close",0);await promise;
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
