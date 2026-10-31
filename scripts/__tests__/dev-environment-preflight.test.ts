import { afterEach, beforeEach, expect, it, vi } from "vitest";

const injected = vi.hoisted(() => ({ missing: true, failure: "MODULE_NOT_FOUND", calls: [] as string[] }));
vi.mock("node:module", async original => {
  const actual = await original<typeof import("node:module")>();
  return { ...actual, createRequire: (from: string | URL) => {
    const require = actual.createRequire(from);
    if (!String(from).endsWith("/apps/control-plane/package.json")) return require;
    const check = (name: string) => {
      injected.calls.push(name);
      if (injected.missing && ["@aws-sdk/client-s3", "pg"].includes(name))
        throw Object.assign(new Error("synthetic-private-provider-value"), { code: injected.failure });
    };
    const load = Object.assign((name: string) => { check(name); return require(name); }, require);
    load.resolve = Object.assign((name: string) => { check(name); return require.resolve(name); }, require.resolve);
    return load;
  } };
});
import { r2Registry } from "../dev-environment/hosted-state.mjs";
import { startPostgres } from "../dev-environment/postgres.mjs";

beforeEach(() => { injected.missing = true; injected.failure = "MODULE_NOT_FOUND"; injected.calls.length = 0; });
afterEach(() => vi.restoreAllMocks());

it.each([r2Registry])("classifies a missing CP SDK at the concrete loader without exposing its message", adapter => {
  let failure: any;
  try { adapter({}); } catch (error) { failure = error; }
  expect(injected.calls).toContain("@aws-sdk/client-s3");
  expect(failure).toMatchObject({ code: "control_plane_dependencies_missing" });
  expect(failure.message).toContain("pnpm --dir apps/control-plane install --frozen-lockfile");
  expect(failure.message).not.toContain("synthetic-private-provider-value");
});

it.each([r2Registry])("keeps non-missing module initialization failures closed and distinct", adapter => {
  injected.failure = "ERR_DLOPEN_FAILED";
  let failure: any;
  try { adapter({}); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "control_plane_dependencies_unavailable" });
  expect(failure.message).not.toContain("synthetic-private-provider-value");
});

it("checks the standalone PG graph before any database filesystem or process action", async () => {
  await expect(startPostgres({}, {}, {}, "/synthetic-checkout")).rejects.toMatchObject({ code: "control_plane_dependencies_missing" });
  expect(injected.calls).toEqual(["pg"]);
});

it("renders only closed actionable dependency diagnostics, never a loader path, stack or message", async () => {
  const { checkControlPlaneDependencies, devEnvironmentDiagnostic } = await import("../dev-environment/dependency-preflight.mjs");
  let failure;
  try { checkControlPlaneDependencies("/synthetic-checkout"); } catch (error) { failure = error; }
  const rendered = JSON.stringify(devEnvironmentDiagnostic(failure));
  expect(JSON.parse(rendered)).toMatchObject({ code: "control_plane_dependencies_missing",
    command: "pnpm --dir apps/control-plane install --frozen-lockfile" });
  expect(rendered).not.toContain("synthetic-private-provider-value");
  expect(rendered).not.toContain("/synthetic-checkout");
  expect(rendered).not.toContain("stack");
  expect(JSON.stringify(devEnvironmentDiagnostic(new Error("synthetic-private-provider-value"))))
    .not.toContain("synthetic-private-provider-value");
});
