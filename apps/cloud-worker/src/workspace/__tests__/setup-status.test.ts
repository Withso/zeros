import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { CloudV2SetupStatusSchema, type CloudV2SetupStatus } from "@zeros/protocol/cloud-v2-relay";
import { WorkspaceSetup, type SetupRunner } from "../setup";
import { config } from "../../__tests__/worker-fixtures";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { script?: string; runner?: SetupRunner; report?: (status: CloudV2SetupStatus) => Promise<void> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "worker-setup-status-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const reports: CloudV2SetupStatus[] = [];
  const report = options.report ?? (async (status: CloudV2SetupStatus) => { reports.push(status); });
  let idle!: () => void;
  const settled = new Promise<void>(resolve => { idle = resolve; });
  const setup: WorkspaceSetup = new WorkspaceSetup({ directory, workspace: { ...config.workspace, checkoutPath: directory, setup: options.script ?? "true" },
    gitEnvironment: {}, runner: options.runner, report, activity: () => { if (!setup.busy) idle(); } });
  cleanups.push(() => setup.dispose());
  const statusDirectory = join(directory, "workspace-setup");
  return { directory, setup, reports, settled, statusDirectory, statusPath: join(statusDirectory, `${config.workspace.id}.json`) };
}

it("reports running at admission and the outcome at the end, as epoch milliseconds with no path, script or log", async () => {
  const f = await fixture({ runner: async () => 3 });
  f.setup.start(true);
  await f.settled;
  await vi.waitFor(() => expect(f.reports).toHaveLength(2));
  const [running, failed] = f.reports;
  expect(running).toEqual({ state: "running", startedAt: expect.any(Number) });
  expect(failed).toEqual({ state: "failed", startedAt: running!.startedAt, finishedAt: expect.any(Number), exitCode: 3 });
  for (const report of f.reports) expect(CloudV2SetupStatusSchema.parse(report)).toEqual(report);
  expect(JSON.stringify(f.reports)).not.toMatch(/workspace-setup|checkoutPath|true/);
});

it("reports the status file after each hello, and a run a hard stop left running as interrupted", async () => {
  const f = await fixture();
  await f.setup.reportCurrent();
  expect(f.reports).toEqual([]); // Never ran: no file, no report.
  await mkdir(f.statusDirectory, { recursive: true });
  const stale = { workspaceId: config.workspace.id, state: "running", startedAt: "2026-11-10T10:00:00.000Z" };
  await writeFile(f.statusPath, JSON.stringify(stale));
  await f.setup.reportCurrent();
  expect(f.reports).toEqual([{ state: "interrupted", startedAt: Date.parse(stale.startedAt) }]);
  // The report never rewrites the admission record.
  expect(JSON.parse(await readFile(f.statusPath, "utf8"))).toEqual(stale);
  await writeFile(f.statusPath, JSON.stringify({ ...stale, state: "failed", finishedAt: "2026-11-10T10:01:00.000Z", exitCode: null, reason: "timed_out",
    source: { path: "scripts/setup.sh", commit: "a".repeat(40), blob: "b".repeat(40) } }));
  await f.setup.reportCurrent();
  expect(f.reports.at(-1)).toEqual({ state: "failed", startedAt: Date.parse(stale.startedAt), finishedAt: Date.parse("2026-11-10T10:01:00.000Z"), reason: "timed_out" });
  await writeFile(f.statusPath, JSON.stringify({ ...stale, workspaceId: "another" }));
  await f.setup.reportCurrent();
  expect(f.reports).toHaveLength(2);
});

it("reports a live run from its file as running, never interrupted", async () => {
  let finish!: (code: number) => void;
  const f = await fixture({ runner: () => new Promise(resolve => { finish = resolve; }) });
  f.setup.start(true);
  await vi.waitFor(() => expect(f.reports).toHaveLength(1));
  await f.setup.reportCurrent();
  expect(f.reports.map(report => report.state)).toEqual(["running", "running"]);
  finish(0);
  await f.settled;
  await vi.waitFor(() => expect(f.reports.at(-1)?.state).toBe("succeeded"));
});

it("never lets a failing report change the setup, and stops retrying on a refusal", async () => {
  const report = vi.fn(async () => { throw Object.assign(new Error("not found"), { status: 404 }); });
  const f = await fixture({ runner: async () => 0, report });
  f.setup.start(true);
  await f.settled;
  await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
  expect(JSON.parse(await readFile(f.statusPath, "utf8"))).toMatchObject({ state: "succeeded", exitCode: 0 });
});
