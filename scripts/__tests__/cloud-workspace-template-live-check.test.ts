import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  cleanupTemplateFork, newTemplateForkJournal, runTemplateForkLiveCheck,
  templateForkEvidenceReader, templateForkLiveConfig, TEMPLATE_FORK_ALPHA_ORIGIN,
} from "../cloud-workspace-validation/template-fork-live-check.mjs";

function fixture() {
  const organizationId = randomUUID(), workspaceId = randomUUID(), buildId = randomUUID();
  const config = { organizationId, repository: { forge: "github.com", owner: "example", name: "repo",
    revision: "main", githubInstallationId: randomUUID() }, expectedSha: "a".repeat(40), accessToken: "private-test-grant" };
  const journal = newTemplateForkJournal(organizationId);
  let accepted = false, deleted = false, posts = 0;
  const row = () => ({ workspace_id: workspaceId, org_id: organizationId, display_name: journal.name, current_generation: 1,
    deleted_at: deleted ? "2026-10-04T00:00:00Z" : null, deletion_state: deleted ? "succeeded" : null,
    image_ref: "boat-template:bx_3456789a", runtime_id: `r1-${"b".repeat(64)}`, runtime_base_image_id: "zeros-v2-test-base",
    runtime_manifest_sha256: "c".repeat(64), runtime_base_compatibility_id: `bc1-${"d".repeat(64)}`,
    build_id: buildId, template_id: buildId, config_id: randomUUID(), template_sandbox_id: "bx_3456789a",
    repository_revision: config.expectedSha, operations: [{ resource_id: "bx_23456789", deleted_at: deleted ? "2026-10-04T00:00:00Z" : null,
      create_closed_at: null }] });
  const configId = randomUUID();
  const database = { active: vi.fn(async () => ({ build_id: buildId })),
    accepted: vi.fn(async () => accepted ? { ...row(), config_id: configId } : null) };
  const request = vi.fn(async (method: string, pathname: string) => {
    if (pathname.endsWith("/cloud-computer/v2")) return { status: 200, body: { active: { id: buildId } } };
    if (method === "POST") {
      accepted = true;
      posts++;
      return { status: posts === 1 ? 202 : 200, body: { replayed: posts > 1, workspace: { id: workspaceId } } };
    }
    if (method === "DELETE") { deleted = true; return { status: 202, body: {} }; }
    return { status: 200, body: { workspace: { id: workspaceId, status: "ready", generation: { runtime: { runtimeId: row().runtime_id } } } } };
  });
  const evidence: string[] = [];
  const dependencies = { request, database, save: vi.fn(value => evidence.push(JSON.stringify(value))),
    wait: vi.fn(async () => {}), attempts: 2 };
  return { config, journal, dependencies, evidence, row, accept: () => { accepted = true; } };
}

describe("template fork Alpha runbook", () => {
  it.skipIf(!process.env.TEST_DATABASE_URL)("reads source and cleanup evidence using the migrated local Postgres schema", async () => {
    const { Pool } = createRequire(new URL("../../apps/control-plane/package.json", import.meta.url))("pg");
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 1,
      options: "-c default_transaction_read_only=on", statement_timeout: 5000 });
    try {
      const reader = templateForkEvidenceReader(pool), organizationId = randomUUID();
      expect(await reader.active(organizationId)).toBeNull();
      expect(await reader.accepted(organizationId, "zeros-v2-test-missing")).toBeNull();
    } finally { await pool.end(); }
  });

  it("records its key before create, proves replay and ready source, and verifies provider cleanup", async () => {
    const f = fixture();
    const result = await runTemplateForkLiveCheck(f.config, f.journal, f.dependencies);
    expect(result).toMatchObject({ replayVerified: true, readyVerified: true, cleanup: "verified", failedChecks: [],
      providerResourceIds: ["bx_23456789"] });
    expect(JSON.parse(f.evidence[0]!)).toMatchObject({ createAttempted: false, workspaceId: null });
    const posts = f.dependencies.request.mock.calls.filter(([method]) => method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(posts[0]?.[2]).toMatchObject({ name: f.journal.name, repository: f.config.repository });
    expect(f.dependencies.request).toHaveBeenCalledWith("DELETE",
      `/v1/organizations/${f.config.organizationId}/cloud-workspaces/${result.workspaceId}`,
      { discardUncheckpointed: true }, `zeros-v2-test-c5-${f.journal.id}.delete`);
    expect(f.evidence.join("\n")).not.toContain(f.config.accessToken);
  });

  it("recovers the cleanup identity from the journal after a lost create reply", async () => {
    const f = fixture(), request = f.dependencies.request.getMockImplementation()!;
    f.dependencies.request.mockImplementation(async (method, pathname) => {
      if (method === "POST") { f.accept(); throw new Error("private response body"); }
      return request(method, pathname);
    });
    const result = await runTemplateForkLiveCheck(f.config, f.journal, f.dependencies);
    expect(result).toMatchObject({ cleanup: "verified", failedChecks: ["verification_failed"], providerResourceIds: ["bx_23456789"] });
    expect(f.evidence.join("\n")).not.toContain("private response body");
  });

  it("does not delete another workspace when the persisted ownership tuple differs", async () => {
    const f = fixture();
    f.journal.createAttempted = true;
    f.dependencies.database.accepted.mockResolvedValue({ ...f.row(), display_name: "a-real-workspace" });
    await expect(cleanupTemplateFork(f.journal, f.dependencies)).rejects.toThrow("ownership_mismatch");
    expect(f.dependencies.request).not.toHaveBeenCalled();
    expect(f.journal.cleanup).toBe("pending");
  });

  it("requires provider deletion evidence even after the API accepts deletion", async () => {
    const f = fixture();
    f.journal.createAttempted = true;
    f.dependencies.database.accepted.mockResolvedValue({ ...f.row(), deleted_at: "2026-10-04T00:00:00Z", deletion_state: "succeeded" });
    await expect(cleanupTemplateFork(f.journal, f.dependencies)).rejects.toThrow("cleanup_pending");
    expect(f.journal.cleanup).toBe("pending");
    expect(f.dependencies.request.mock.calls.every(([method]) => method === "DELETE")).toBe(true);
  });

  it("retains ambiguous no-row outcomes, but closes an explicit pre-allocation rejection", async () => {
    const f = fixture();
    f.journal.createAttempted = true;
    await expect(cleanupTemplateFork(f.journal, f.dependencies)).rejects.toThrow("cleanup_pending");
    f.journal.createRejected = true;
    await cleanupTemplateFork(f.journal, f.dependencies);
    expect(f.journal.cleanup).toBe("not_created");
    expect(f.dependencies.request).not.toHaveBeenCalled();
  });

  it("uses a read-only transaction with the existing RLS system context", async () => {
    const query = vi.fn(async () => ({ rows: [] })), release = vi.fn();
    const reader = templateForkEvidenceReader({ connect: async () => ({ query, release }) });
    expect(await reader.accepted(randomUUID(), "zeros-v2-test-missing")).toBeNull();
    expect(query.mock.calls.slice(0, 3).map(([sql]) => sql)).toEqual([
      "BEGIN READ ONLY", "SET LOCAL ROLE zeros_app", "SELECT set_config('app.system', 'on', true)",
    ]);
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts only the Alpha database declaration and rejects routing overrides without printing values", () => {
    const f = fixture();
    const database = new URL("postgresql://template-live.example.psdb.cloud/zeros?sslmode=verify-full");
    database.username = "reader.branch"; // Synthetic login name, no password or network request.
    const values = { ZEROS_C5_ALPHA_DATABASE_URL: database.toString(),
      ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-alpha", ZEROS_C5_ALPHA_ACCESS_TOKEN: f.config.accessToken,
      ZEROS_C5_ALPHA_ORGANIZATION_ID: f.config.organizationId, ZEROS_C5_ALPHA_INSTALLATION_ID: f.config.repository.githubInstallationId,
      ZEROS_C5_ALPHA_REPOSITORY_OWNER: "example", ZEROS_C5_ALPHA_REPOSITORY_NAME: "repo", ZEROS_C5_ALPHA_REVISION: "main",
      ZEROS_C5_ALPHA_EXPECTED_SHA: f.config.expectedSha };
    expect(templateForkLiveConfig(values)).toMatchObject(f.config);
    expect(TEMPLATE_FORK_ALPHA_ORIGIN).toBe("https://api-alpha.zeros.build");
    for (const override of [{ ZEROS_PLANETSCALE_ALPHA_DATABASE: "zeros-control-plane-beta" },
      { ZEROS_C5_ALPHA_DATABASE_URL: values.ZEROS_C5_ALPHA_DATABASE_URL + "&host=somewhere-else" }])
      expect(() => templateForkLiveConfig({ ...values, ...override })).toThrow(/^input_invalid$/);
  });
});
