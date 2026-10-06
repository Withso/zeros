import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchCloudHistory } from "../cloud-history-fetch";

const git = vi.hoisted(() => vi.fn());
vi.mock("../git-exec", () => ({ runGit: git }));
let root: string;
const budget = { timeoutMs: 1000, pollMs: 5, maxBytes: 128 };
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "zeros-v2-test-history-"));
  await mkdir(path.join(root, "objects"));
  // Existing history is not charged against this fetch's growth limit.
  await writeFile(path.join(root, "objects/existing"), Buffer.alloc(512));
  git.mockReset().mockResolvedValueOnce({ stdout: "objects\n", stderr: "" });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const untilAborted = (signal: AbortSignal) => new Promise<never>((_, reject) => {
  if (signal.aborted) reject(new Error("aborted"));
  else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
});
it("stops at the time limit, kills the process group and does not retry the operation", async () => {
  git.mockImplementationOnce((_cwd, _args, options) => untilAborted(options.signal));
  expect(await fetchCloudHistory(root, ["fetch"], { ...budget, timeoutMs: 30 })).toEqual({ summary: "", historyLimited: true });
  expect(git).toHaveBeenCalledTimes(2);
  expect(git.mock.lastCall?.[2]).toMatchObject({ processGroup: true, signal: expect.any(AbortSignal) });
  expect(git.mock.lastCall?.[2].signal.aborted).toBe(true);
});
it("stops at the growth limit while a fetch is running", async () => {
  git.mockImplementationOnce(async (_cwd, _args, options) => {
    await writeFile(path.join(root, "objects/new-pack"), Buffer.alloc(256));
    return untilAborted(options.signal);
  });
  expect(await fetchCloudHistory(root, ["fetch"], budget)).toEqual({ summary: "", historyLimited: true });
  expect(git).toHaveBeenCalledTimes(2);
});
it("checks final growth even when a fetch finishes between samples", async () => {
  git.mockImplementationOnce(async () => {
    await writeFile(path.join(root, "objects/new-pack"), Buffer.alloc(256));
    return { stdout: "", stderr: "done" };
  });
  expect(await fetchCloudHistory(root, ["fetch"], budget)).toEqual({ summary: "", historyLimited: true });
});
it("returns successful fetch output without counting pre-existing objects", async () => {
  git.mockResolvedValueOnce({ stdout: "", stderr: " fetched \n" });
  expect(await fetchCloudHistory(root, ["fetch"], budget)).toEqual({ summary: "fetched" });
});
it("preserves non-limit failures for the managed action and never retries them", async () => {
  const failure = new Error("credential grant expired");
  git.mockRejectedValueOnce(failure);
  await expect(fetchCloudHistory(root, ["fetch"], budget)).rejects.toBe(failure);
  expect(git).toHaveBeenCalledTimes(2);
});
it("fails closed if history growth cannot be measured", async () => {
  git.mockImplementationOnce(async () => {
    await rm(path.join(root, "objects"), { recursive: true });
    return { stdout: "", stderr: "" };
  });
  await expect(fetchCloudHistory(root, ["fetch"], budget)).rejects.toThrow("Could not measure cloud Git history");
});
