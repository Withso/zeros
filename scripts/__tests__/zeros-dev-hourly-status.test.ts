import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshHourlyStatuses, createHourlyStatusWriter, HOURLY_STATUS } from "../ci/zeros-dev-status.mjs";

const head = "a".repeat(40), now = Date.parse("2026-10-14T01:00:00Z");
afterEach(() => vi.restoreAllMocks());
const run = (id: number, conclusion = "success") => ({ id, run_number: id, run_attempt: 1,
  path: ".github/workflows/zeros-dev-e2e.yml", name: "Zeros dev E2E", head_sha: "b".repeat(40),
  head_branch: "main", event: "schedule", status: "completed", conclusion,
  repository: { full_name: "Withso/zeros" }, head_repository: { full_name: "Withso/zeros" } });
function fixture({ latest = run(17, "failure"), live = true, file = "apps/control-plane/src/index.ts" } = {}) {
  const pr = { number: 123, state: "open", changed_files: 1, commits: 1, labels: [], head: { sha: head }, base: { ref: "main", repo: { full_name: "Withso/zeros" } } };
  const api = { get: vi.fn(async (url: string) => {
    if (url.includes("/pulls?")) return [pr];
    if (url.endsWith("/pulls/123")) return pr;
    if (url.includes("/files?")) return [{ filename: file, status: "modified" }];
    if (url.includes("status=success")) return { total_count: live ? 1 : 0, workflow_runs: live ? [run(16)] : [] };
    if (url.includes("/jobs?")) return { total_count: 1, jobs: [{ name: "lifecycle", status: "completed", conclusion: "success", run_attempt: 1,
      completed_at: "2026-10-14T00:08:00Z", steps: [
        { name: "Execute Alpha product lifecycle", status: "completed", conclusion: "success" },
        { name: "Save signed cleanup receipt", status: "completed", conclusion: "success" },
      ] }] };
    if (url.includes("/runs?")) return { total_count: 1, workflow_runs: [latest] };
    throw new Error("unregistered read");
  }) };
  return { api, pr, publish: vi.fn(async (_value: unknown) => {}) };
}

describe("required hourly statuses remain current after a PR's CI has finished", () => {
  it("replaces the previous success with pending, then failure when the latest canary is red", async () => {
    const f = fixture(); await refreshHourlyStatuses(f.api, f.publish, { now });
    expect(f.publish.mock.calls.map(([row]) => row)).toEqual([
      { head, state: "pending", code: "hourly_checking" }, { head, state: "failure", code: "hourly_failed", alert: false },
    ]);
  });
  it("only alerts a no-cloud change while a cloud canary is red", async () => {
    const f = fixture({ file: "docs/development-environments.md" });
    await refreshHourlyStatuses(f.api, f.publish, { now });
    expect(f.publish).toHaveBeenLastCalledWith({ head, state: "success", code: "hourly_failed", alert: true });
  });
  it("automatically activates after first real green and rejects two-hour-old success", async () => {
    for (const [live, observed, state, code] of [[false, now, "success", "hourly_not_live"], [true, now, "success", "hourly_green"],
      [true, Date.parse("2026-10-14T02:08:00Z"), "failure", "hourly_stale"]] as const) {
      const f = fixture({ live, latest: run(17) }); await refreshHourlyStatuses(f.api, f.publish, { now: observed });
      expect(f.publish).toHaveBeenLastCalledWith({ head, state, code, alert: false });
    }
  });
  it("cannot post success for a head that changed during scope or review reads", async () => {
    const f = fixture({ latest: run(17) }), get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async url => url.endsWith("/pulls/123") && ++reads === 2 ? { ...f.pr, head: { sha: "c".repeat(40) } } : get(url));
    await refreshHourlyStatuses(f.api, f.publish, { now });
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({ head, state: "pending", code: "hourly_checking" });
  });
  it("checks freshness after the final async head read instead of extending it by network latency", async () => {
    let clock = now;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const f = fixture({ latest: run(17) }), get = f.api.get.getMockImplementation()!; let reads = 0;
    f.api.get.mockImplementation(async url => {
      if (url.endsWith("/pulls/123") && ++reads === 2) clock = Date.parse("2026-10-14T02:08:00Z");
      return get(url);
    });
    await refreshHourlyStatuses(f.api, f.publish);
    expect(f.publish).toHaveBeenLastCalledWith({ head, state: "failure", code: "hourly_stale", alert: false });
  });
  it("fails closed on unavailable history and incomplete file lists", async () => {
    const f = fixture(), get = f.api.get.getMockImplementation()!;
    f.api.get.mockImplementation(async url => url.includes("/runs?") ? Promise.reject(new Error("private response")) : get(url));
    await refreshHourlyStatuses(f.api, f.publish, { now });
    expect(f.publish).toHaveBeenLastCalledWith({ head, state: "failure", code: "hourly_unavailable", alert: false });
    f.pr.changed_files = 2; f.api.get.mockImplementation(get);
    await refreshHourlyStatuses(f.api, f.publish, { now });
    expect(f.publish).toHaveBeenLastCalledWith({ head, state: "failure", code: "hourly_unavailable", alert: false });
  });
  it("the privileged writer posts only the one fixed context, repository, head and closed code", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 201 }));
    const publish = createHourlyStatusWriter({ token: "synthetic-token", workflowRunId: "123", fetchImpl: fetcher });
    for (const input of [{ head: "../foreign", state: "success", code: "hourly_green" }, { head, state: "anything", code: "hourly_green" },
      { head, state: "success", code: "private response" }]) await expect(publish(input)).rejects.toThrow("hourly_status_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
    await publish({ head, state: "failure", code: "hourly_stale" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/Withso/zeros/statuses/${head}`);
    expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit");
    expect(JSON.parse(String(init.body))).toEqual({ state: "failure", context: HOURLY_STATUS, description: "hourly_stale", target_url: "https://github.com/Withso/zeros/actions/runs/123" });
  });
});
