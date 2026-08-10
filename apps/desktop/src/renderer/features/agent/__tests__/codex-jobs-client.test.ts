import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());

vi.mock("../../../platform/bridge/active-bridge", () => ({
  getActiveBridge: () => ({ request }),
}));

import {
  cancelCodexJob,
  getCodexJob,
  listCodexJobs,
  startCodexJob,
} from "../codex-jobs-client";

const snapshot = {
  id: "job-1",
  status: "queued" as const,
  createdAt: 1,
};

describe("Codex jobs renderer client", () => {
  beforeEach(() => request.mockReset());

  it("starts, reads, lists, and cancels through correlated bridge requests", async () => {
    request
      .mockResolvedValueOnce({ type: "CODEX_JOB_SNAPSHOT", job: snapshot })
      .mockResolvedValueOnce({ type: "CODEX_JOB_SNAPSHOT", job: snapshot })
      .mockResolvedValueOnce({ type: "CODEX_JOBS_LIST", jobs: [snapshot] })
      .mockResolvedValueOnce({
        type: "CODEX_JOB_SNAPSHOT",
        job: { ...snapshot, status: "cancelled" },
      });

    await expect(
      startCodexJob({ cwd: "/tmp/project", prompt: "Run tests" }),
    ).resolves.toEqual(snapshot);
    await expect(getCodexJob("job-1")).resolves.toEqual(snapshot);
    await expect(listCodexJobs()).resolves.toEqual([snapshot]);
    await expect(cancelCodexJob("job-1")).resolves.toMatchObject({
      status: "cancelled",
    });

    expect(request.mock.calls.map(([value]) => value.type)).toEqual([
      "CODEX_JOB_START",
      "CODEX_JOB_GET",
      "CODEX_JOB_LIST",
      "CODEX_JOB_CANCEL",
    ]);
  });

  it("surfaces correlated engine errors and rejects wrong response types", async () => {
    request.mockResolvedValueOnce({
      type: "CODEX_JOB_SNAPSHOT",
      job: null,
      error: { code: "UNAVAILABLE", message: "runtime unavailable" },
    });
    await expect(getCodexJob("job-1")).rejects.toMatchObject({
      name: "CodexJobClientError",
      code: "UNAVAILABLE",
    });

    request.mockResolvedValueOnce({ type: "HEARTBEAT" });
    await expect(listCodexJobs()).rejects.toThrow(/Unexpected response/);
  });
});
