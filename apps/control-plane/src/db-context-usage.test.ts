import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Integration tests connect as a superuser, which bypasses row-level security,
// so a raw pool read of a FORCE RLS table returns rows in tests and none in
// production. Every connection the application takes from a pool must go
// through withSystemTx, withSystemStatement or withUserTx, which set the
// RLS context. A raw `pool.query`, `pool.connect()` or dedicated `pg.Client`
// is allowed only at a reviewed site below.

/** `file#function` → why the raw connection is safe there. */
const ALLOWED: Record<string, string> = {
  "src/db.ts#withUserTx": "The helper itself: sets the user RLS context on the acquired client.",
  "src/db.ts#withSystemStatement": "The helper itself: sets the system RLS context on the acquired client.",
  "src/db.ts#withSystemTx": "The helper itself: sets the system RLS context on the acquired client.",
  "src/app.ts#createApp": "Health and readiness probes run SELECT 1 only.",
  "src/chaos/fault-pool.ts#faultInjectingPool":
    "Chaos tests only: forwards connect and query to the wrapped pool unchanged, so the context helpers still run.",
  "src/postgres-notifications.ts#acquire": "Dedicated LISTEN session; it issues only LISTEN/UNLISTEN.",
  "src/workos-provider-locks.ts#connectBeforeDeadline": "Session holder for WorkOS advisory locks; it never reads tables.",
  "src/cloud-workspaces/computer-retirement.ts#retire":
    "Lock-pool session holds the retirement advisory lock; table access uses withSystemTx.",
  "src/cloud-provider-evidence.ts#databaseClock": "Reads clock_timestamp() only.",
  "src/cloud-provider-evidence.ts#readBoatInventory":
    "Operator read-only transaction that sets app.system itself before reading the journal.",
  "src/dev-agent-qualification.ts#inspectDevAgents":
    "zeros_development_identity is a hosted-Dev table outside the migrations, without RLS.",
  "src/development-environment.ts#assertHostedDatabaseOwnership":
    "Reads zeros_development_identity (no RLS) and pg_roles to prove runtime privileges.",
  "src/dev-connections/bootstrap.ts#bootstrapDevConnectionDatabase":
    "Administrative bootstrap of the separate dev_connections database.",
  "src/dev-connections/migrate.ts#migrateDevConnections": "Migration owner of the separate dev_connections database.",
  "src/dev-connections/migrate.ts#checkDevConnectionsSchema": "Reads the dev_connections migration ledger, which has no RLS.",
  "src/dev-connections/quarantine.ts#quarantineRestoredConnections":
    "Separate dev_connections database; sets its own broker authority per transaction.",
  "src/dev-connections/store.ts#tx": "Separate dev_connections database; sets role and broker authority per transaction.",
  "src/load-sim/harness.ts#createSimulator": "Load simulator LISTEN client on a scratch database.",
  "src/load-sim/server-stats.ts#open": "Load simulator statistics setup on a scratch database.",
  "src/load-sim/server-stats.ts#transactions": "Load simulator reads pg_stat views only.",
  "src/load-sim/server-stats.ts#begin": "Load simulator resets and reads pg_stat views only.",
  "src/migrate.ts#withMigrationClient": "Migration runner on the migration-owner connection.",
  "src/migrate.ts#planMigrations": "Migration planner on the migration-owner connection.",
  "src/reset-database.ts#resetPublicSchema": "Operator database reset on the owner connection.",
  "src/reset-database.ts#inspectRowCounts": "Operator reset approval counts on the owner connection.",
  // Operator CLIs open their own transaction and set app.system before any
  // table access, on the pool the operator supplies.
  "src/manage-account-pro.ts#manageAccountPro": "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-agent-runtime.ts#manageCloudAgentRuntime": "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-capability-key.ts#manageCloudCapabilityKey":
    "Operator CLI on the migration-owner pool; sets app.system in its own transaction.",
  "src/manage-cloud-computer-snapshots.ts#manageCloudComputerSnapshots":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-provider-absence.ts#manageCloudProviderAbsence":
    "Operator CLI; beginProviderAttestation sets app.system in its own transaction.",
  "src/manage-cloud-provider-loss.ts#manageCloudProviderLoss":
    "Operator CLI; beginProviderAttestation sets app.system in its own transaction.",
  "src/manage-cloud-owner-checkpoint-recovery.ts#manageCloudOwnerCheckpointRecovery":
    "Owner-only CLI; sets app.system in its own transaction before table access and retains the migration-owner role for the discard receipt.",
  "src/manage-cloud-owner-discard-delete.ts#manageCloudOwnerDiscardDelete":
    "Owner-only CLI; sets app.system in its own transaction and requires the migration owner for one exact complete-loss Delete receipt.",
  "src/manage-cloud-owner-existing-delete.ts#manageCloudOwnerExistingDelete":
    "Owner-only CLI; sets app.system before table access and retains the migration owner for loss on one exact existing Delete.",
  "src/manage-cloud-rollout-flag.ts#manageCloudRolloutFlag":
    "Operator CLI on the migration-owner pool; sets app.system in its own transaction.",
  "src/manage-cloud-workspace-deletion.ts#manageCloudWorkspaceDeletion":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-workspace-entitlement.ts#manageCloudWorkspaceEntitlement":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-workspace-object-rotation.ts#manageCloudWorkspaceObjectRotationRetry":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-workspace-object-storage.ts#manageCloudWorkspaceObjectStorage":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-cloud-workspace-quota.ts#manageCloudWorkspaceQuota": "Operator CLI; sets app.system in its own transaction.",
  "src/manage-staff.ts#manageStaffRole": "Operator CLI; sets app.system in its own transaction.",
  "src/manage-workos-provider-erasure.ts#inspectWorkOSProviderErasureReadiness":
    "Operator CLI; sets app.system in its own transaction.",
  "src/manage-workos-provider-erasure.ts#manageWorkOSProviderErasureEvidenceUnlocked":
    "Operator CLI; sets app.system in its own transaction.",
};

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") && !/test|fixture/.test(entry.name) ? [file] : [];
  });
}

function enclosingFunctionName(node: ts.Node): string {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name)
      return current.name.getText();
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent))
      return current.parent.name.getText();
    if (ts.isConstructorDeclaration(current)) return "constructor";
  }
  return "<module>";
}

const POOL_RECEIVER = /pool$/i;

/** Raw connection sites in one source file, as `file#function:line` keys. */
export function rawConnectionSites(file: string, text: string): Array<{ key: string; line: number }> {
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const sites: Array<{ key: string; line: number }> = [];
  const record = (node: ts.Node) =>
    sites.push({
      key: `${file}#${enclosingFunctionName(node)}`,
      line: tree.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    });
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const receiverName = ts.isPropertyAccessExpression(receiver)
        ? receiver.name.text
        : ts.isIdentifier(receiver)
          ? receiver.text
          : ts.isCallExpression(receiver) || receiver.kind === ts.SyntaxKind.SuperKeyword
            ? ""
            : receiver.getText();
      if ((method === "query" || method === "connect") && POOL_RECEIVER.test(receiverName)) record(node);
    }
    // The receiver check above is name-based; this keeps it sound by making
    // every Pool-typed binding carry a name it recognizes.
    if (
      (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) &&
      node.type &&
      /^(?:Pick<\s*)?(?:pg\.)?Pool\b/.test(node.type.getText()) &&
      !POOL_RECEIVER.test(node.name.getText())
    )
      record(node);
    if (ts.isNewExpression(node)) {
      const created = node.expression.getText();
      if (created === "Client" || created === "pg.Client") record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return sites;
}

describe("database context usage", () => {
  it("flags a raw pool read of an RLS table outside the context helpers", () => {
    const source = `
      import { withSystemTx } from "./db.js";
      export async function readRevision(pool: pg.Pool, id: string) {
        return (await pool.query("SELECT revision FROM cloud_workspaces WHERE id = $1", [id])).rows;
      }
      export async function viaHelper(pool: pg.Pool) {
        return withSystemTx(pool, async client => client.query("SELECT 1"));
      }
      export async function renamed(db: pg.Pool) {
        return db.query("SELECT 1");
      }
      export class Store {
        constructor(private readonly pool: pg.Pool) {}
        async lease() { const client = await this.pool.connect(); client.release(); }
      }
    `;
    expect(rawConnectionSites("src/example.ts", source)).toEqual([
      { key: "src/example.ts#readRevision", line: 4 },
      { key: "src/example.ts#renamed", line: 9 },
      { key: "src/example.ts#lease", line: 14 },
    ]);
  });

  it("takes every pool connection through an RLS context helper or a reviewed site", () => {
    const root = path.resolve(".");
    const unreviewed: string[] = [];
    const used = new Set<string>();
    for (const file of sources(path.resolve("src"))) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      for (const site of rawConnectionSites(relative, readFileSync(file, "utf8"))) {
        if (ALLOWED[site.key]) used.add(site.key);
        else unreviewed.push(`${site.key}:${site.line}`);
      }
    }
    expect(unreviewed).toEqual([]);
    expect(Object.keys(ALLOWED).filter(key => !used.has(key))).toEqual([]);
    for (const reason of Object.values(ALLOWED)) expect(reason.length).toBeGreaterThan(10);
  });
});
