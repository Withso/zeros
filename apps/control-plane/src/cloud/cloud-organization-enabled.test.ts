// One rule for whether an organization's cloud is on (cloud_organization_enabled,
// 0262). A query that repeats the old test instead would silently leave a
// Personal organization with Pro out of cloud, or let one in on another path.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const source = join(__dirname, "..");
const migrations = join(source, "..", "migrations");
const read = (file: string) => readFileSync(join(source, file), "utf8");
const OLD_TEST = /NOT\s+(?:[A-Za-z_]+\.)?is_personal\s+AND\s+(?:[A-Za-z_]+\.)?cloud_workspaces_allowed/;
const COLUMN = /cloud_workspaces_allowed/g;
const fixture = (file: string) => file.endsWith(".test.ts") || file.endsWith(".test-suite.ts") || file.includes("__fixtures__")
  || /(^|\/)test-(fixture|fixtures|pro|support)\b/.test(file);
const runtimeFiles = () => (readdirSync(source, { recursive: true }) as string[]).filter(file => file.endsWith(".ts") && !fixture(file));

// Every other place the column is named, with how many times and why it may.
// A bare read of a Personal organization's column is always false (the CHECK
// personal_organizations_are_local_only), so a missed reader fails closed; this
// list keeps new ones from being added without a decision.
const ALLOWED: Record<string, { count: number; reason: string }> = {
  "routes.ts": { count: 5, reason: "the organization summary's row type and fallback, and organization create (never Personal) returning it" },
  "manage-cloud-workspace-entitlement.ts": { count: 10, reason: "the operator tool that sets an organization's column; it still refuses Personal" },
  "cloud/api/credentials.ts": { count: 1, reason: "an organization-wide agent connection (line 149), which a Personal organization never has" },
  "cloud/execution/authority.ts": { count: 1, reason: "the shared-execution signature input; shared execution is never Personal" },
  "cloud/team-sharing/authority.ts": { count: 1, reason: "the team-sharing signature input; team sharing is never Personal" },
  "auth.ts": { count: 1, reason: "Personal organization create, which writes false as the CHECK requires" },
  "manage-account-pro.ts": { count: 6, reason: "account_entitlements' own column, not organizations" },
  "cloud/rehearsal/live.ts": { count: 4, reason: "the rehearsal (operator tooling): account_entitlements' own column in its Pro read, and the local stack's staff organization it creates (never Personal), which writes false" },
  "cloud/rehearsal/plan.ts": { count: 1, reason: "the rehearsal's read-only diagnostic, printed when a projects read answers 404; it decides nothing" },
};
const ALLOWED_MIGRATIONS: Record<string, { count: number; reason: string }> = {
  "0262_cloud_organization_enabled.sql": { count: 3, reason: "the function itself and its header" },
};

it("never tests an organization's cloud with the old expression; every query calls cloud_organization_enabled", () => {
  expect(runtimeFiles().filter(file => OLD_TEST.test(read(file)))).toEqual([]);
  for (const file of ["cloud/workspace-access.ts", "cloud/store.ts", "cloud/computer.ts", "cloud/github-connections-store.ts", "cloud/api/credentials.ts",
    "cloud/team-sharing/store.ts", "cloud/projects.ts", "cloud/repository-levels.ts", "cloud/ready-copies.ts", "cloud/environment-store.ts",
    "mcp/store.ts", "agent-credentials/agent-credentials.ts", "agent-credentials/agent-credential-mutations.ts", "github-repository-authority.ts"])
    expect(read(file), file).toContain("cloud_organization_enabled(");
});

it("reads cloud_workspaces_allowed only where the allowlist says why", () => {
  const found = Object.fromEntries(runtimeFiles().map(file => [file, read(file).match(COLUMN)?.length ?? 0]).filter(([, count]) => count));
  expect(found).toEqual(Object.fromEntries(Object.entries(ALLOWED).map(([file, { count }]) => [file, count])));
  // Migrations after 0261 are held to the same rule; earlier ones are history.
  const later = readdirSync(migrations).filter(file => file.endsWith(".sql") && Number(file.slice(0, 4)) > 261)
    .map(file => [file, readFileSync(join(migrations, file), "utf8").match(COLUMN)?.length ?? 0] as const).filter(([, count]) => count);
  expect(Object.fromEntries(later)).toEqual(Object.fromEntries(Object.entries(ALLOWED_MIGRATIONS).map(([file, { count }]) => [file, count])));
});

it("gives every server pool that runs organization queries the Personal cloud switch", () => {
  // index.ts makes its pools only through createServerPools, which configures each.
  expect(read("index.ts")).not.toMatch(/\bcreatePool\(/);
  expect(read("index.ts")).toContain("createServerPools(");
  const unconfigured = read("server-pools.ts").split("\n").filter(line => /\bcreatePool\(/.test(line) && !/configured\(createPool\(/.test(line));
  // The listener pool only runs LISTEN.
  expect(unconfigured).toEqual([expect.stringContaining("config.databaseListenUrl")]);
});

it("writes shared execution only through the operator's activation, which refuses a Personal organization", () => {
  // Every other path (create, wake, restart, recovery) keeps a workspace's mode; a create takes it from
  // the organization it admits (store.ts insertWorkspace), so a Personal workspace stays on the creator path.
  const WRITE = /(?:\bSET|,)\s*execution_mode\s*=\s*'(\w+)'/g;
  const writers = runtimeFiles().flatMap(file => [...read(file).matchAll(WRITE)].map(match => `${file}:${match[1]}`)).sort();
  expect(writers).toEqual(["cloud/execution/activation-state.ts:prepared", "cloud/execution/activation.ts:active",
    "manage-cloud-execution.ts:legacy", "manage-cloud-execution.ts:prepared"]);
  expect(runtimeFiles().filter(file => /INSERT INTO cloud_v2_workspaces\b[^;]*\bexecution_mode\b/.test(read(file)))).toEqual(["cloud/store.ts"]);
  expect(read("manage-cloud-execution.ts")).toContain("A Personal organization's cloud workspaces run on the creator path only");
});
