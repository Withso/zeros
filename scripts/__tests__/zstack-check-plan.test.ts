import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { decideScope, loadPolicy, selectChecks } from "../ci/scope.mjs";
import { planVerification, assertExecutablePlan } from "../zstack/check-plan.mjs";
import { runCommand } from "../zstack/runner.mjs";

const policy = loadPolicy();
const head = "a".repeat(40), base = "b".repeat(40), fingerprint = "c".repeat(64);
const source = "scripts/zstack/check-plan.mjs", test = "scripts/__tests__/zstack-check-plan.test.ts";
const evidence = (paths = [source]) => ({ baseSha: base, sourceSha: head, fingerprint, complete: true,
  changes: paths.map(path => ({ path, status: "M" })) });
const plan = (extra = {}) => planVerification({ policy, evidence: evidence(), files: [source, test], platform: "linux", ...extra });
const commands = (value: ReturnType<typeof plan>) => value.local.map((check: { argv: string[] }) => check.argv.join(" "));

describe("zstack check planning", () => {
  it("reuses every selected CI check and adds the required local gates plus exact adjacent suites", () => {
    const value = plan(), decision = decideScope({ policy, changes: evidence().changes });
    expect(value.ci.map((check: { id: string }) => check.id)).toEqual(selectChecks(policy, decision));
    expect(value.scope).toEqual(decision);
    expect(commands(value)).toEqual(expect.arrayContaining(["pnpm typecheck", "pnpm lint", "pnpm check:ui", "pnpm check:secrets",
      `pnpm test:git ${test}`, `pnpm exec eslint ${source}`]));
    expect(commands(value)).not.toContain("pnpm test:git");
    expect(value.identity).toMatchObject({ sourceSha: head, baseSha: base, fingerprint });
    expect(() => assertExecutablePlan(value)).not.toThrow();
  });

  it("selects both paths of a move and never turns incomplete evidence into a narrow plan", () => {
    const moved = { ...evidence(), changes: [{ path: "docs/moved.md", oldPath: "apps/control-plane/src/index.ts", status: "R" }] };
    const value = plan({ evidence: moved, tests: [test] });
    expect(value.scope.lanes["control-plane"]).toBe(true);
    const incomplete = plan({ evidence: { ...evidence(), complete: false } });
    expect(incomplete.scope.full).toBe(true);
    expect(incomplete.blocked).toContain("diff_incomplete");
    expect(() => assertExecutablePlan(incomplete)).toThrow("zstack_plan_blocked");
  });

  it("keeps Local engine checks separate from native macOS proof on Linux", () => {
    const file = "apps/desktop/src/engine/workspace/service.ts", adjacent = "apps/desktop/src/engine/workspace/__tests__/service.test.ts";
    const value = plan({ evidence: evidence([file]), files: [file, adjacent] });
    expect(commands(value)).toContain(`pnpm test:git ${adjacent}`);
    expect(commands(value)).not.toContain("pnpm smoke:engine");
    expect(value.ci).toContainEqual(expect.objectContaining({ id: "source-sync-macos", reason: "requires_macos" }));
    expect(commands(plan({ evidence: evidence([file]), files: [file, adjacent], platform: "darwin" }))).toContain("pnpm smoke:engine");
  });

  it("runs adjacent CP tests in their package without selecting the full CP suite locally", () => {
    const file = "apps/control-plane/src/cloud-workspaces/operations.ts", adjacent = file.replace(/\.ts$/, ".test.ts");
    const value = plan({ evidence: evidence([file]), files: [file, adjacent] });
    expect(commands(value)).toContain("pnpm --dir apps/control-plane typecheck");
    expect(commands(value)).toContain("pnpm --dir apps/control-plane exec vitest run src/cloud-workspaces/operations.test.ts");
    expect(commands(value)).not.toContain("pnpm test:control-plane");
    expect(value.ci.some((check: { id: string }) => check.id === "control-plane-database")).toBe(true);
  });

  it("keeps mixed root, control-plane and cloud-worker suites in their owning packages", () => {
    const cp = "apps/control-plane/src/config.test.ts";
    const worker = "apps/cloud-worker/src/drivers/cursor/__tests__/usage-accounting.test.ts";
    const workerSource = "apps/cloud-worker/src/drivers/cursor/usage-accounting.ts";
    const value = plan({ evidence: evidence([workerSource, source, cp]),
      files: [cp, worker, workerSource, source, test], tests: [worker, test, cp, worker] });
    expect(value.blocked).toEqual([]);
    expect(value.local.filter(check => check.kind === "vitest").map(check => check.argv)).toEqual([
      ["pnpm", "test:git", test],
      ["pnpm", "--dir", "apps/control-plane", "exec", "vitest", "run", "src/config.test.ts"],
      ["pnpm", "--dir", "apps/cloud-worker", "exec", "vitest", "run", "--config", "vitest.config.ts",
        "src/drivers/cursor/__tests__/usage-accounting.test.ts"],
    ]);
    expect(() => assertExecutablePlan(value)).not.toThrow();
  });

  it("executes inferred cloud-worker assertions through the real planned recipe", async () => {
    const file = "apps/cloud-worker/src/drivers/cursor/usage-accounting.ts";
    const adjacent = "apps/cloud-worker/src/drivers/cursor/__tests__/usage-accounting.test.ts";
    const value = plan({ evidence: evidence([file]), files: [file, adjacent] });
    expect(value.blocked).toEqual([]);
    const check = value.local.find(check => check.kind === "vitest");
    expect(check).toBeDefined();
    const result = await runCommand(check!, {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeoutMs: 60_000,
    });
    expect(result).toMatchObject({ status: "passed", code: "ok", tests: { success: true, failed: 0, pending: 0 } });
    expect(result.tests!.passed).toBeGreaterThan(0);
    expect(result.tests!.total).toBe(result.tests!.passed);
  }, 70_000);

  it("requires an explicit adjacent suite when source has no discoverable test", () => {
    const value = plan({ files: [source] });
    expect(value.blocked).toContain("adjacent_tests_required");
    expect(() => assertExecutablePlan(value)).toThrow("zstack_plan_blocked");
    expect(plan({ files: [source, "scripts/__tests__/repository-layout.test.ts"], tests: ["scripts/__tests__/repository-layout.test.ts"] }).blocked).toEqual([]);
  });

  it("retains unfamiliar CI commands as deferred evidence instead of executing policy text", () => {
    const changedPolicy = structuredClone(policy);
    changedPolicy.checks["tracked-secrets"].commands.push("node -e process.exit(99)");
    const value = plan({ policy: changedPolicy });
    expect(value.ci.find((check: { id: string }) => check.id === "tracked-secrets").commands).toContain("node -e process.exit(99)");
    expect(commands(value).some((command: string) => command.includes("process.exit"))).toBe(false);
  });

  it.each(["../foreign.test.ts", "scripts/__tests__/x.test.ts\n--watch", ".env.agent", "scripts/__tests__/missing.test.ts"])("refuses unregistered test input %s", invalid => {
    expect(() => plan({ tests: [invalid] })).toThrow("zstack_test_invalid");
  });

  it("does not execute a serialized, edited or caller-created plan", () => {
    const value = plan();
    expect(Object.isFrozen(value.local[0].argv)).toBe(true);
    expect(() => assertExecutablePlan(JSON.parse(JSON.stringify(value)))).toThrow("zstack_plan_invalid");
  });
});
