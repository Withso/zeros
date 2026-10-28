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

  it("keeps every CSS selector parser above the CPU exhaustion advisory floor", () => {
    expect(vulnerableHolders(rootLock, "postcss-selector-parser", "6.1.5")).toEqual([]);
    const vulnerableSeven = Object.keys(rootLock.packages).filter(key => key.startsWith("postcss-selector-parser@7.") &&
      below(key.slice("postcss-selector-parser@".length), "7.1.6"));
    expect(vulnerableSeven).toEqual([]);
  });

  it("keeps the audited build-tool dependency lines above their advisory floors", () => {
    const floors = [
      ["@babel/core", "7.29.6"], ["@vitest/mocker", "4.1.12"],
      ["app-builder-lib", "26.15.0"], ["axios", "1.20.0"],
      ["baseline-browser-mapping", "2.11.0"], ["browserslist", "4.28.7"],
      ["brace-expansion", "1.1.21"], ["brace-expansion", "2.1.7"], ["brace-expansion", "5.0.12"],
      ["builder-util-runtime", "9.7.0"], ["follow-redirects", "1.16.1"],
      ["form-data", "4.0.6"], ["joi", "18.2.9"], ["shell-quote", "1.11.0"],
      ["tar", "7.5.21"], ["tmp", "0.2.7"], ["undici", "6.29.1"], ["undici", "7.30.1"],
    ];
    const vulnerable: string[] = [];
    for (const [name, floor] of floors) {
      const prefix = `${name}@`;
      const major = floor.split(".")[0];
      for (const key of Object.keys(rootLock.packages)) {
        if (key.startsWith(`${prefix}${major}.`) && below(key.slice(prefix.length), floor)) vulnerable.push(key);
      }
    }
    expect(vulnerable).toEqual([]);
    expect(Object.keys(rootLock.packages).filter(key => key.startsWith("esbuild@0.27."))).toEqual([]);
  });

  it("checks the independent deployment graphs instead of inferring safety from the root graph", () => {
    const marketingLock = yaml<Lock>("apps/marketing/pnpm-lock.yaml");
    for (const lock of [controlPlaneLock, marketingLock]) {
      for (const [name, floor] of [["postcss", "8.5.23"], ["nanoid", "3.3.18"], ["source-map-js", "1.2.2"], ["vite", "7.3.7"]])
        expect(vulnerableHolders(lock, name, floor), name).toEqual([]);
    }
    expect(vulnerableHolders(controlPlaneLock, "@vitest/mocker", "4.1.12")).toEqual([]);
    for (const [name, floor] of [["baseline-browser-mapping", "2.11.0"], ["browserslist", "4.28.7"], ["tar", "7.5.21"]])
      expect(vulnerableHolders(marketingLock, name, floor), name).toEqual([]);
    const webLock = JSON.parse(readFileSync(path.join(root, "apps/web/package-lock.json"), "utf8")) as { packages: Record<string, { version?: string }> };
    for (const [name, floor] of [["wrangler", "4.153.0"], ["undici", "7.30.1"], ["sharp", "0.35.5"]]) {
      for (const [key, entry] of Object.entries(webLock.packages)) {
        if (key.endsWith(`node_modules/${name}`)) expect(below(entry.version!, floor), key).toBe(false);
      }
    }
  });
});
