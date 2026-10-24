import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const yaml = <T>(file: string) =>
  load(readFileSync(path.join(root, file), "utf8")) as T;

type Workspace = { auditConfig?: { ignoreGhsas?: string[] } };
type Lock = {
  importers: Record<
    string,
    Partial<
      Record<
        "dependencies" | "optionalDependencies",
        Record<string, { version: string }>
      >
    >
  >;
  snapshots: Record<
    string,
    Partial<
      Record<"dependencies" | "optionalDependencies", Record<string, string>>
    >
  >;
};

// Each reviewed exception names the vulnerable package, its first patched
// release and the only locked parents still allowed to hold an older copy.
const REVIEWED: Record<
  string,
  { name: string; patched: string; parents: readonly string[] }
> = {
  // Cursor SDK 1.0.37 calls single-argument z.record(), which zod 4 rejects,
  // so this pinned provider runtime cannot take zod 4.6.6. Its private zod 3
  // parses provider traffic, not public requests. Retire the exception with
  // the qualified Cursor SDK update that makes zod a peer dependency.
  "GHSA-mrhx-c7xc-m3w5": {
    name: "zod",
    patched: "4.6.6",
    parents: ["@cursor/sdk@1.0.37"],
  },
};

const version = (value: string) => value.replace(/\(.*$/, "");
function below(value: string, floor: string) {
  const left = version(value).split(".").map(Number);
  const right = floor.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index];
  }
  return false;
}
function vulnerableHolders(lock: Lock, name: string, patched: string) {
  const holders: string[] = [];
  for (const [importer, groups] of Object.entries(lock.importers)) {
    for (const group of [groups.dependencies, groups.optionalDependencies]) {
      const locked = group?.[name]?.version;
      if (locked && below(locked, patched)) holders.push(`importer:${importer}`);
    }
  }
  for (const [snapshot, groups] of Object.entries(lock.snapshots)) {
    for (const group of [groups.dependencies, groups.optionalDependencies]) {
      const locked = group?.[name];
      if (locked && below(locked, patched)) holders.push(version(snapshot));
    }
  }
  return [...new Set(holders)].sort();
}

describe("reviewed production audit exceptions", () => {
  const rootWorkspace = yaml<Workspace>("pnpm-workspace.yaml");
  const rootLock = yaml<Lock>("pnpm-lock.yaml");
  const controlPlaneLock = yaml<Lock>("apps/control-plane/pnpm-lock.yaml");
  const ignored = rootWorkspace.auditConfig?.ignoreGhsas ?? [];

  it("ignores only reviewed advisories", () => {
    expect(ignored.filter((ghsa) => !(ghsa in REVIEWED))).toEqual([]);
  });

  it.each(Object.entries(REVIEWED))(
    "limits %s to its reviewed locked parents",
    (ghsa, { name, patched, parents }) => {
      const holders = vulnerableHolders(rootLock, name, patched);
      if (!ignored.includes(ghsa)) return;
      expect(holders.length, `${ghsa} no longer needs an exception`).toBe(
        parents.length,
      );
      expect(holders).toEqual([...parents].sort());
    },
  );

  it("keeps Cursor SDK pinned while its zod exception exists", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(root, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    if (!ignored.includes("GHSA-mrhx-c7xc-m3w5")) return;
    expect(pkg.dependencies["@cursor/sdk"]).toBe("1.0.37");
  });

  it("keeps the public control plane on patched releases without exceptions", () => {
    const workspace = yaml<Workspace | null>(
      "apps/control-plane/pnpm-workspace.yaml",
    );
    expect(workspace?.auditConfig?.ignoreGhsas ?? []).toEqual([]);
    expect(vulnerableHolders(controlPlaneLock, "zod", "4.6.6")).toEqual([]);
    expect(vulnerableHolders(controlPlaneLock, "body-parser", "2.4.0")).toEqual(
      [],
    );
  });

  it("locks every other root zod and body-parser copy at a patched release", () => {
    expect(
      vulnerableHolders(rootLock, "zod", "4.6.6").filter(
        (holder) => !REVIEWED["GHSA-mrhx-c7xc-m3w5"].parents.includes(holder),
      ),
    ).toEqual([]);
    expect(vulnerableHolders(rootLock, "body-parser", "2.4.0")).toEqual([]);
  });
});
