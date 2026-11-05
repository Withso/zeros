import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
const { load } = createRequire(import.meta.url)("js-yaml") as { load(value: string): any };
const text = readFileSync(new URL("../../.github/workflows/runtime-release.yml", import.meta.url), "utf8"), workflow = load(text);
const step = (job: any, name: string) => job.steps.find((entry: any) => entry.name === name);

describe("runtime release workflow authority", () => {
  it("always cleans the exact attempt on the same ephemeral runner before any artifact action", () => {
    const release = workflow.jobs.release, cleanup = step(release, "Retire runtime release authority");
    expect(cleanup?.if).toBe("always()");
    expect(cleanup?.run).toBe("pnpm exec tsx scripts/release/runtime-cli.ts --cleanup");
    expect(release["runs-on"]).toBe("ubuntu-latest");
    const executeIndex = release.steps.indexOf(step(release, "Qualify and pin runtime"));
    const cleanupIndex = release.steps.indexOf(cleanup);
    expect(cleanupIndex).toBe(executeIndex + 1);
    expect(cleanupIndex).toBeLessThan(release.steps.indexOf(step(release, "Save runtime receipt")));
    expect(JSON.stringify(cleanup)).not.toMatch(/CLOUD_V2_RUNTIME_CANARY_PRIVATE_KEY|CLOUD_RUNTIME_ALPHA_STORE/);
  });
  it("is dispatch-only with closed channel/action choices and read-only GitHub access", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.on.workflow_dispatch.inputs.channel.options).toEqual(["alpha", "beta", "production"]);
    expect(workflow.on.workflow_dispatch.inputs.action.options).toEqual(["publish", "promote", "rollback"]);
    expect(workflow.permissions).toEqual({ contents: "read", actions: "read" });
    expect(text).not.toMatch(/contents: write|actions: write|id-token: write|secrets: inherit/);
  });
  it("holds both existing destination locks for the entire publish/qualify/pin transaction", () => {
    expect(workflow.concurrency).toEqual({ group: "release-${{ inputs.channel }}", "cancel-in-progress": false });
    expect(workflow.jobs.release.concurrency).toEqual({ group: "hosted-mutation-${{ inputs.channel }}", "cancel-in-progress": false });
    expect(step(workflow.jobs.release, "Qualify and pin runtime").run).toBe("pnpm exec tsx scripts/release/runtime-cli.ts --execute");
    expect(workflow.jobs.release["timeout-minutes"]).toBe(70);
  });
  it("builds the exact requested source without channel credentials or a secret environment", () => {
    const build = workflow.jobs.build;
    expect(build.environment).toBeUndefined(); expect(JSON.stringify(build)).not.toContain("secrets.");
    expect(build.if).toContain("github.ref == 'refs/heads/main'"); expect(build.if).toContain("inputs.channel == 'alpha'");
    const checkouts = build.steps.filter((entry: any) => entry.uses?.startsWith("actions/checkout@"));
    expect(checkouts.map((entry: any) => entry.with.ref)).toEqual(["${{ github.sha }}", "${{ inputs.source_sha }}"]);
    expect(checkouts.every((entry: any) => entry.with["persist-credentials"] === false)).toBe(true);
    expect(checkouts[1].with.path).toBe(".context/runtime-candidate");
    expect(step(build, "Save runtime archive").with.name).toBe("runtime-archive-${{ github.run_id }}-${{ github.run_attempt }}");
  });
  it("uses the existing Production approval environment and does not create a Beta gate", () => {
    const approve = workflow.jobs.approve, release = workflow.jobs.release;
    expect(approve.environment).toBe("production-approval"); expect(approve.permissions).toEqual({});
    expect(approve.if).toContain("inputs.channel == 'production'"); expect(approve.if).toContain("refs/heads/release/");
    expect(JSON.stringify(approve)).not.toContain("secrets."); expect(JSON.stringify(approve)).not.toContain("actions/checkout");
    expect(step(approve, "Record runtime approval")).toBeDefined();
    expect(release.needs).toEqual(["approve", "build"]); expect(release.if).toContain("needs.approve.result == 'success'");
    expect(release.environment).toBe("${{ inputs.channel }}");
    expect(release.if).toContain("inputs.channel == 'beta'"); expect(text).not.toContain("beta-approval");
  });
  it("keeps secrets in the controller and its immediate cleanup step, and binds evidence to the attempt", () => {
    const release = workflow.jobs.release, execute = step(release, "Qualify and pin runtime"), cleanup = step(release, "Retire runtime release authority");
    expect(JSON.stringify(release.env)).not.toContain("secrets.");
    for (const entry of release.steps) if (entry !== execute && entry !== cleanup) expect(JSON.stringify(entry)).not.toContain("secrets.");
    for (const job of Object.values(workflow.jobs) as any[]) for (const entry of job.steps ?? []) if (entry.run) {
      expect(entry.run).not.toContain("${{"); expect(entry.run).not.toMatch(/echo.*(TOKEN|PASSWORD|PRIVATE_KEY)/);
    }
    const archive = step(release, "Read exact-attempt runtime archive");
    expect(archive.with.name).toBe("runtime-archive-${{ github.run_id }}-${{ github.run_attempt }}");
    const proof = step(release, "Save runtime receipt"), recovery = step(release, "Save runtime recovery records");
    expect(proof.with.name).toBe("runtime-release-${{ github.run_id }}-${{ github.run_attempt }}");
    expect(proof.with["if-no-files-found"]).toBe("error");
    expect(recovery.if).toBe("failure() || cancelled()"); expect(recovery.with.name).toContain("recovery");
    for (const entry of release.steps) if (entry.uses?.startsWith("actions/upload-artifact@")) {
      expect(entry.with.path).toBe(".context/runtime-release/");
      expect(JSON.stringify(entry)).not.toContain("RUNNER_TEMP");
    }
    expect(text).not.toMatch(/CLOUD_V2_WORKER_SIGNING_KEY|CONTROL_PLANE_STAFF|staff:manage|railway up/);
  });
  it("pins every external action to a full commit", () => {
    for (const job of Object.values(workflow.jobs) as any[]) for (const entry of job.steps ?? []) if (entry.uses) expect(entry.uses).toMatch(/^[\w/-]+@[a-f0-9]{40}$/);
  });
});

describe("runtime release database CI admission", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["ci.yml", "preflight.yml"])("runs the real database controls in %s against its own healthy PostgreSQL service", file => {
    const pipeline = load(readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), "utf8"));
    const jobs = (Object.values(pipeline.jobs) as any[]).filter(job =>
      job.steps?.some((entry: any) => entry.run?.includes("--config scripts/release/vitest.config.ts")));
    expect(jobs).toHaveLength(1);
    for (const job of jobs) {
      const test = job.steps.find((entry: any) => entry.run?.includes("--config scripts/release/vitest.config.ts"));
      const postgres = job.services?.postgres;
      expect(postgres?.image).toBe("postgres:18");
      expect(postgres?.options?.includes("pg_isready")).toBe(true);
      expect(postgres?.ports).toContain("5432:5432");
      const env = { ...pipeline.env, ...job.env, ...test.env };
      expect(typeof env.TEST_DATABASE_URL === "string").toBe(true);
      let database: URL | null = null;
      try { database = new URL(env.TEST_DATABASE_URL); } catch { /* Invalid fixture configuration is reported without its value. */ }
      expect(database !== null).toBe(true);
      expect(["postgres:", "postgresql:"].includes(database!.protocol)).toBe(true);
      expect(["localhost", "127.0.0.1"].includes(database!.hostname)).toBe(true);
      expect(database!.port).toBe("5432");
      expect(database!.search).toBe("");
      expect(decodeURIComponent(database!.pathname.slice(1)) === (postgres.env.POSTGRES_DB ?? "postgres")).toBe(true);
      expect(decodeURIComponent(database!.username) === (postgres.env.POSTGRES_USER ?? "postgres")).toBe(true);
      expect(decodeURIComponent(database!.password) === postgres.env.POSTGRES_PASSWORD).toBe(true);
    }
  });

  it.each([false, true])("serializes schema-resetting release files only when a test database is configured (%s)", async database => {
    vi.stubEnv("TEST_DATABASE_URL", database ? "synthetic-test-database" : undefined);
    vi.resetModules();
    const config = (await import("./vitest.config")).default as any;
    expect(config.test.fileParallelism ?? true).toBe(!database);
  });
});
