import { describe, expect, it } from "vitest";
import { validateServicesReceipt } from "./github";

const sourceSha = "a".repeat(40), digest = "b".repeat(64);
const config = { sourceSha, branch: "main", repository: "example/zeros" };
const run = { id: 123, run_attempt: 3, status: "in_progress", conclusion: null, event: "push", head_sha: sourceSha, head_branch: "main",
  path: ".github/workflows/release-alpha.yml", repository: { full_name: config.repository }, head_repository: { full_name: config.repository } };
function serviceReceipt() { return { version: 1, status: "services-ready", channel: "alpha", ...config, runId: "123", runAttempt: "1",
  migration: { mode: "execute", database: "zeros-control-plane-alpha", branch: { name: "main", production: true }, backup: { id: "backup", state: "success" },
    controlledApprovals: [], pendingMigrations: [], applied: [], ledger: "verified", role: { deleted: true } }, railwayDeploymentId: "deployment",
  backend: { version: 1, ready: true, sourceSha, channel: "alpha", maintenance: false,
    migrations: { state: "current", head: "0121_example.sql", expectedHead: "0121_example.sql", manifestSha256: digest },
    cloud: { enabled: false, ready: true, state: "disabled" }, worker: null },
  pages: [{ id: "app", surface: "app" }, { id: "ops", surface: "ops" }],
  workos: { kind: "workos-handshake-v1", surfaces: ["app", "ops"], verifiedAt: "2026-09-30T00:00:00.000Z" }, completedAt: "2026-09-30T00:00:01.000Z" }; }
function job(kind: "services", patch: Record<string, unknown> = {}) {
  return { run_id: 123, run_attempt: 1, head_sha: sourceSha, head_branch: "main", status: "completed", conclusion: "success",
    name: "Hosted promotion (alpha) / Hosted services",
    steps: ["Promote services and verify WorkOS", "Save services receipt"]
      .map(name => ({ name, conclusion: "success" })), ...patch };
}
describe("authenticated release artifact handoff", () => {
  it("retains services receipt discovery under the encompassing Alpha reusable call", async () => {
    const services = job("services", { name: "Alpha publication / Hosted promotion (alpha) / Hosted services" });
    expect(validateServicesReceipt(serviceReceipt(), run, config, "alpha", [services])).toMatchObject({ runId: "123", runAttempt: "1" });
  });

  it("accepts only services-ready proof and its recorded successful producer attempt", () => {
    expect(validateServicesReceipt(serviceReceipt(), run, config, "alpha", [job("services")]).status).toBe("services-ready");
    expect(() => validateServicesReceipt({ ...serviceReceipt(), status: "success" }, run, config, "alpha", [job("services")])).toThrow();
  });

  it.each([
    { head_sha: "c".repeat(40) }, { head_branch: "release/1.2.3" }, { repository: { full_name: "other/zeros" } },
    { head_repository: { full_name: "fork/zeros" } }, { event: "pull_request" }, { path: ".github/workflows/other.yml" }, { run_attempt: "3" },
  ])("refuses untrusted parent workflow evidence %j", async patch => {
    expect(() => validateServicesReceipt(serviceReceipt(), { ...run, ...patch }, config, "alpha", [job("services")])).toThrow();
  });
  it.each([{ channel: "beta" }, { sourceSha: "c".repeat(40) }, { repository: "other/zeros" }, { branch: "release/1.2.3" }, { runId: "124" }, { runAttempt: "4" }])(
    "refuses another channel, source, run or future attempt %j", async patch => {
      expect(() => validateServicesReceipt({ ...serviceReceipt(), ...patch }, run, config, "alpha", [job("services")])).toThrow();
    });
  it.each([{ run_id: 124 }, { run_attempt: 2 }, { head_sha: "c".repeat(40) }, { head_branch: "other" }, { conclusion: "failure" }, { status: "in_progress" },
    { name: "untrusted writer" }, { steps: [{ name: "Save success receipt", conclusion: "success" }] }])("rejects missing or failed producer evidence %j", async patch => {
      expect(() => validateServicesReceipt(serviceReceipt(), run, config, "alpha", [job("services", patch)])).toThrow();
    });

  it("requires all channel surfaces, WorkOS proof, migration execution and the matching API", () => {
    const services = serviceReceipt();
    for (const patch of [{ pages: services.pages.slice(0, 1) }, { workos: undefined },
      { migration: { ...services.migration, mode: "plan" } }, { backend: { ...services.backend, channel: "beta" } }])
      expect(() => validateServicesReceipt({ ...services, ...patch }, run, config, "alpha", [job("services")])).toThrow();
  });
});
