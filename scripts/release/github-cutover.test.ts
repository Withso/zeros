import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { githubClient } from "./github";

const sha = "a".repeat(40);
const config = { repository: "example/zeros", sourceSha: sha, branch: "release/1.2.3" };
const run = { id: 7, head_sha: sha, status: "completed", conclusion: "success", event: "workflow_dispatch", path: ".github/workflows/controlled-cutover.yml",
  repository: { full_name: "example/zeros" }, head_repository: { full_name: "example/zeros" } };
const receipt = (overrides: Record<string, unknown> = {}) => ({
  version: 1, status: "cutover-complete", channel: "production", sourceSha: sha, branch: "release/1.2.3", repository: "example/zeros",
  runId: "7", runAttempt: "1", approvals: [],
  migration: { mode: "execute", database: "zeros-control-plane-production", branch: { name: "main", production: true }, backup: { id: "backup1", state: "success" },
    controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } },
  maintenanceDeploymentId: "deploy1", railwayDeploymentId: "deploy2",
  backend: { version: 1, ready: true, sourceSha: sha, channel: "production", maintenance: false,
    migrations: { state: "current", head: "0121_x.sql", expectedHead: "0121_x.sql", manifestSha256: "b".repeat(64) },
    cloud: { enabled: false, ready: true, state: "disabled" }, worker: null },
  pages: [{ id: "page1", surface: "app" }, { id: "page2", surface: "ops" }],
  workos: { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: "2026-10-01T00:00:00.000Z" },
  completedAt: "2026-10-01T00:00:00.000Z", ...overrides,
});

function client(runs: unknown[], downloaded: unknown) {
  return githubClient(config, { GH_TOKEN: "fake-token" }, {
    fetch: async input => {
      const route = String(input);
      if (route.includes("/workflows/controlled-cutover.yml/runs?")) return Response.json({ workflow_runs: runs });
      if (route.includes("/artifacts?")) return Response.json({ artifacts: [{ name: `controlled-cutover-production-${sha}`, expired: false, workflow_run: { head_sha: sha } }] });
      throw new Error("Unexpected API route");
    },
    command: async (file, args, options) => {
      expect(file).toBe("gh"); expect(args).not.toContain("fake-token"); expect(options?.env?.GH_TOKEN).toBe("fake-token");
      await writeFile(path.join(args[args.indexOf("--dir") + 1], "cutover-receipt.json"), JSON.stringify(downloaded));
      return "";
    },
  });
}

describe("controlled-cutover receipt evidence", () => {
  it("accepts only a successful cutover run's own complete receipt for the channel and SHA", async () => {
    expect(await client([run], receipt()).cutoverReceipt("production", sha)).toBe(true);
  });
  it.each([
    ["another channel", receipt({ channel: "beta" })],
    ["another run", receipt({ runId: "8" })],
    ["a backend on another commit", receipt({ backend: { ...receipt().backend, sourceSha: "c".repeat(40) } })],
    ["a missing Ops upload", receipt({ pages: [{ id: "page1", surface: "app" }] })],
    ["unverified WorkOS for Ops", receipt({ workos: { kind: "workos-handshake-v1", surfaces: ["app"], verifiedAt: "2026-10-01T00:00:00.000Z" } })],
  ])("rejects %s", async (_name, downloaded) => {
    expect(await client([run], downloaded).cutoverReceipt("production", sha)).toBe(false);
  });
  it("ignores failed, forked or differently pathed runs", async () => {
    for (const other of [{ ...run, conclusion: "failure" }, { ...run, head_repository: { full_name: "fork/zeros" } }, { ...run, path: ".github/workflows/release.yml" }]) {
      expect(await client([other], receipt()).cutoverReceipt("production", sha)).toBe(false);
    }
  });
});
