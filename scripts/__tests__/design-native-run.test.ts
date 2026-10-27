import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acceptNativeHostReport,
  acquireNativeRunLock,
  collectNativeSourceManifest,
  fenceLegacyNativeLaunch,
  nativeQualificationProcesses,
  readNativeReportJson,
  writeNativeJson,
} from "../design-native-run.mjs";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-native-run-test-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe("native qualification ownership", () => {
  it("refuses a second launcher while preserving the live owner's lock", () => {
    const release = acquireNativeRunLock(root, "first");
    const before = fs.readFileSync(path.join(root, "run.lock"), "utf8");
    expect(() => acquireNativeRunLock(root, "second")).toThrow(/still be running/);
    expect(fs.readFileSync(path.join(root, "run.lock"), "utf8")).toBe(before);
    release();
    const next = acquireNativeRunLock(root, "second");
    expect(JSON.parse(fs.readFileSync(path.join(root, "run.lock"), "utf8")).runId).toBe("second");
    next();
  });

  it("preserves a dead owner's marker when recovering its lock", () => {
    const previous = { pid: 12345, token: randomUUID(), runId: "abandoned" };
    fs.writeFileSync(path.join(root, "run.lock"), JSON.stringify(previous));
    const release = acquireNativeRunLock(root, "next", () => false);
    expect(JSON.parse(fs.readFileSync(path.join(root, `abandoned-lock-${previous.token}.json`), "utf8"))).toEqual(previous);
    release();
  });

  it("does not treat unknown process state as proof that a run stopped", () => {
    fs.writeFileSync(path.join(root, "run.lock"), JSON.stringify({ pid: 12345, token: randomUUID() }));
    expect(() => acquireNativeRunLock(root, "next", () => null)).toThrow(/still be running/);
  });

  it("refuses malformed and symlinked markers without overwriting them", () => {
    const file = path.join(root, "run.lock");
    fs.writeFileSync(file, "partial-json");
    expect(() => acquireNativeRunLock(root, "next")).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe("partial-json");
    fs.unlinkSync(file);
    const source = path.join(root, "keep.json");
    fs.writeFileSync(source, JSON.stringify({ pid: process.pid, token: randomUUID() }));
    fs.symlinkSync(source, file);
    expect(() => acquireNativeRunLock(root, "next")).toThrow(/regular file/);
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("finds earlier workers and native fixtures without exposing process arguments", () => {
    const table = [
      "1 0 Ss login",
      "10 1 S zsh -c node scripts/design-native-run.mjs",
      "11 10 S node scripts/design-native-run.mjs",
      "12 1 S node scripts/electron-local.mjs",
      "13 12 S /Electron.app/Contents/MacOS/Electron /repo/dist-electron/main.cjs",
      "14 1 S node /repo/.context/design-performance-continuation/native-qualification-worker-v4.mjs --credential=do-not-retain",
      "15 1 S /Electron.app/Contents/MacOS/Electron /repo/.context/native-design-app-example/app",
      "16 1 Z node scripts/design-native-product.mjs",
      "17 1 S node scripts/design-native-owners.mjs",
    ].join("\n");
    const result = nativeQualificationProcesses(table, 11);
    expect(result).toEqual([{ pid: 14, ppid: 1 }, { pid: 15, ppid: 1 }, { pid: 17, ppid: 1 }]);
    expect(JSON.stringify(result)).not.toContain("credential");
  });

  it("fences a late legacy request without overwriting an existing launch", () => {
    fenceLegacyNativeLaunch(root, "replacement");
    const file = path.join(root, ".context", "design-performance-continuation", "native-v4-launch.json");
    const fence = fs.readFileSync(file, "utf8");
    expect(JSON.parse(fence).status).toBe("superseded");
    expect(() => fs.openSync(file, "wx")).toThrow();
    fenceLegacyNativeLaunch(root, "later");
    expect(fs.readFileSync(file, "utf8")).toBe(fence);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: "earlier" }));
    expect(() => fenceLegacyNativeLaunch(root, "later")).toThrow(/Recover that run/);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).startedAt).toBe("earlier");
  });
});

describe("native qualification evidence", () => {
  const stage = { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:02:00Z", exitCode: 0 };
  const report = { checkedAt: "2026-01-01T00:01:00Z", platform: "darwin", checks: ["native check"] };

  it("preserves the confirmed report and removes its partial write when disk space is exhausted", () => {
    const file = path.join(root, "report.json");
    fs.writeFileSync(file, JSON.stringify({ stage: "measuring" }));
    const write = fs.writeFileSync.bind(fs);
    const failure = Object.assign(new Error("No space left on device"), { code: "ENOSPC" });
    const fault = vi.spyOn(fs, "writeFileSync").mockImplementation((target, _data, options) => {
      write(target, "{partial", options);
      throw failure;
    });
    try { expect(() => writeNativeJson(file, { stage: "complete" })).toThrow(failure); }
    finally { fault.mockRestore(); }
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ stage: "measuring" });
    expect(fs.readdirSync(root)).toEqual(["report.json"]);
  });

  it("accepts only fresh successful native host evidence", () => {
    expect(acceptNativeHostReport(stage, report)).toBe(1);
    expect(() => acceptNativeHostReport({ ...stage, exitCode: 1 }, report)).toThrow();
    expect(() => acceptNativeHostReport({ ...stage, timedOut: true }, report)).toThrow();
    expect(() => acceptNativeHostReport({ ...stage, cancelled: true }, report)).toThrow();
    expect(() => acceptNativeHostReport(stage, { ...report, platform: "linux" })).toThrow();
    expect(() => acceptNativeHostReport(stage, { ...report, checks: [] })).toThrow();
    expect(() => acceptNativeHostReport(stage, { ...report, checkedAt: "2025-12-31T00:01:00Z" })).toThrow();
    expect(() => acceptNativeHostReport(stage, { ...report, checkedAt: "2026-01-02T00:01:00Z" })).toThrow();
  });

  it("hashes new source files while excluding ignored runtime data and credentials", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), ".context/\n.env*\n");
    fs.mkdirSync(path.join(root, "scripts"));
    fs.mkdirSync(path.join(root, ".context"));
    fs.writeFileSync(path.join(root, "scripts", "fixture.mjs"), "export const version = 1;");
    fs.writeFileSync(path.join(root, "scripts", ".env.fixture"), "PRIVATE_VALUE=never-in-report");
    fs.writeFileSync(path.join(root, ".context", "result.json"), "{}");
    const before = collectNativeSourceManifest(root);
    expect(before.files.map((file: { file: string }) => file.file)).toEqual([".gitignore", "scripts/fixture.mjs"]);
    expect(JSON.stringify(before)).not.toContain("never-in-report");
    fs.writeFileSync(path.join(root, "scripts", "fixture.mjs"), "export const version = 2;");
    expect(collectNativeSourceManifest(root).digest).not.toBe(before.digest);
  });

  it("binds evidence to root build inputs and native resources as well as application source", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.mkdirSync(path.join(root, "resources"));
    const inputs = ["index.html", "tsconfig.build.json", "postcss.config.mjs", "tsup.config.ts", "resources/icon.png"];
    for (const file of inputs) fs.writeFileSync(path.join(root, file), "initial");
    for (const file of inputs) {
      const before = collectNativeSourceManifest(root);
      fs.writeFileSync(path.join(root, file), "changed");
      expect(collectNativeSourceManifest(root).digest, file).not.toBe(before.digest);
    }
  });

  it("includes the bundled provider and model catalogs needed by an isolated renderer", () => {
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.mkdirSync(path.join(root, "catalogs"));
    const inputs = ["catalogs/models-v1.json", "catalogs/providers-v1.json"];
    for (const file of inputs) fs.writeFileSync(path.join(root, file), "{\"version\":1}");
    const original = collectNativeSourceManifest(root);
    expect(original.files.map((file: { file: string }) => file.file)).toEqual(inputs);
    for (const file of inputs) {
      const before = collectNativeSourceManifest(root);
      fs.writeFileSync(path.join(root, file), "{\"version\":2}");
      expect(collectNativeSourceManifest(root).digest, file).not.toBe(before.digest);
    }
  });

  it("recovers a measured report larger than a launcher marker", () => {
    const report = { checks: ["native workloads"], samples: Array.from({ length: 5000 }, (_, pid) =>
      ({ pid, role: "renderer", rssBytes: 1024, cpuSeconds: pid / 100 })) };
    const file = path.join(root, "performance-report.json");
    const data = JSON.stringify(report);
    expect(Buffer.byteLength(data)).toBeGreaterThan(256 * 1024);
    fs.writeFileSync(file, data);
    expect(readNativeReportJson(file)).toEqual(report);
  });

  it("keeps report reads bounded and rejects symlinks", () => {
    const file = path.join(root, "performance-report.json");
    fs.writeFileSync(file, " ".repeat(4 * 1024 * 1024 + 1));
    expect(() => readNativeReportJson(file)).toThrow(/bounded regular file/);
    fs.writeFileSync(file, "{}");
    const linked = path.join(root, "linked-report.json");
    fs.symlinkSync(file, linked);
    expect(() => readNativeReportJson(linked)).toThrow(/bounded regular file/);
    fs.writeFileSync(path.join(root, "run.lock"), JSON.stringify({ pid: 12345, token: randomUUID(), padding: "x".repeat(256 * 1024) }));
    expect(() => acquireNativeRunLock(root, "next", () => false)).toThrow(/bounded regular file/);
  });
});
