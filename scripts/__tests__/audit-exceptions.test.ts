import { readFileSync } from "node:fs";
import path from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const yaml = <T>(file: string) =>
  load(readFileSync(path.join(root, file), "utf8")) as T;

type Workspace = { auditConfig?: { ignoreGhsas?: string[] } };
type Lock = {
  packages: Record<string, unknown>;
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

describe("production audit policy", () => {
  const rootWorkspace = yaml<Workspace>("pnpm-workspace.yaml");
  const rootLock = yaml<Lock>("pnpm-lock.yaml");
  const controlPlaneLock = yaml<Lock>("apps/control-plane/pnpm-lock.yaml");
  const ignored = rootWorkspace.auditConfig?.ignoreGhsas ?? [];

  it("keeps the root production audit free of advisory exceptions", () => {
    expect(ignored).toEqual([]);
  });

  it("retires the Cursor zod exception and every vulnerable locked copy", () => {
    expect(ignored).not.toContain("GHSA-mrhx-c7xc-m3w5");
    for (const lock of [rootLock, controlPlaneLock]) {
      const zodPackages = Object.keys(lock.packages).filter((key) =>
        key.startsWith("zod@"),
      );
      expect(zodPackages.length).toBeGreaterThan(0);
      expect(
        zodPackages.filter((key) => below(key.slice("zod@".length), "4.6.6")),
      ).toEqual([]);
      expect(vulnerableHolders(lock, "zod", "4.6.6")).toEqual([]);
    }
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

  it("locks every root zod and body-parser copy at a patched release", () => {
    expect(vulnerableHolders(rootLock, "zod", "4.6.6")).toEqual([]);
    expect(vulnerableHolders(rootLock, "body-parser", "2.4.0")).toEqual([]);
  });
});
