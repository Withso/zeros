import { afterEach, expect, it, vi } from "vitest";
import { startStartupMaintenance } from "../startup-maintenance";

afterEach(() => vi.restoreAllMocks());

it("can stop before the first task starts", async () => {
  const run = vi.fn();
  await startStartupMaintenance([{ name: "archive-refs", run }]).stop();
  expect(run).not.toHaveBeenCalled();
});

it("runs one task at a time and joins an aborted flight without starting its successor", async () => {
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  let signal!: AbortSignal;
  const next = vi.fn();
  const maintenance = startStartupMaintenance([
    { name: "archive-refs", run: async (current) => { signal = current; entered(); await held; } },
    { name: "branch-refs", run: next },
  ]);
  await started;
  expect(next).not.toHaveBeenCalled();
  let stopped = false;
  const stopping = maintenance.stop().then(() => { stopped = true; });
  expect(signal.aborted).toBe(true);
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(stopped).toBe(true);
  expect(next).not.toHaveBeenCalled();
});

it("isolates an optional failure and logs only its closed phase", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  let finish!: () => void;
  const completed = new Promise<void>((resolve) => { finish = resolve; });
  const maintenance = startStartupMaintenance([
    { name: "archive-refs", run: async () => { throw new Error("private repository path"); } },
    { name: "branch-refs", run: async () => { finish(); } },
  ]);
  await completed;
  await maintenance.stop();
  expect(warning).toHaveBeenCalledExactlyOnceWith(
    "[Zeros] startup maintenance archive-refs deferred until next launch",
  );
});
