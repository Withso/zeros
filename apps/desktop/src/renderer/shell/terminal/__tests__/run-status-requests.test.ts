import { afterEach, expect, it, vi } from "vitest";

const read = vi.hoisted(() => vi.fn());
vi.mock("../../../platform/git", () => ({ workspaceRunInfo: read }));
import { runInfoForRefresh } from "../use-run-status";

const query = { workspaceId: "ws-a", sessionIds: ["run-a"] };
afterEach(() => read.mockReset());

it("shares Summary and Terminal reads for a mount and each run transition", async () => {
  read.mockResolvedValue({ actions: {} });
  await Promise.all([runInfoForRefresh(query, 0), runInfoForRefresh(query, 0)]);
  expect(read).toHaveBeenCalledTimes(1);
  await Promise.all([runInfoForRefresh(query, 1), runInfoForRefresh(query, 1)]);
  expect(read).toHaveBeenCalledTimes(2);
});

it("never lets a start response swallow a newer stop or another workspace's read", async () => {
  let finish!: (value: unknown) => void;
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  read.mockResolvedValue({ actions: { dev: { state: "stopped" } } });
  const started = runInfoForRefresh(query, 1);
  const stopped = runInfoForRefresh(query, 2);
  const other = runInfoForRefresh({ ...query, workspaceId: "ws-b" }, 2);
  await expect(stopped).resolves.toEqual({
    actions: { dev: { state: "stopped" } },
  });
  await other;
  expect(read).toHaveBeenCalledTimes(3);
  finish({ actions: { dev: { state: "running" } } });
  await started;
});

it("a failed request releases its slot for retry", async () => {
  read.mockRejectedValueOnce(new Error("offline"));
  await expect(runInfoForRefresh(query, 0)).rejects.toThrow("offline");
  read.mockResolvedValueOnce({ actions: {} });
  await expect(runInfoForRefresh(query, 0)).resolves.toEqual({ actions: {} });
});
