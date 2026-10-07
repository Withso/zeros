import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudWorkspaceOwnership } from "../cloud-workspace-ownership";

describe.runIf(process.platform === "linux")("cloud workspace file publication", () => {
  let temporary: string, root: string;
  const changeOwner = vi.fn();
  let owner: CloudWorkspaceOwnership;
  beforeEach(() => {
    temporary = mkdtempSync(path.join(tmpdir(), "zeros-cloud-file-owner-"));
    root = path.join(temporary, "workspace");
    mkdirSync(root);
    changeOwner.mockReset();
    owner = new CloudWorkspaceOwnership(root, { uid: 10001, gid: 10001 }, changeOwner);
  });
  afterEach(() => rmSync(temporary, { force: true, recursive: true }));

  it("publishes newly authored files and parent directories without broadening permissions", () => {
    const target = path.join(root, "Design", "frame.html");
    mkdirSync(path.dirname(target), { mode: 0o700 });
    writeFileSync(target, "fixture", { mode: 0o600 });
    owner.publish(target);
    expect(changeOwner).toHaveBeenCalledTimes(2);
    for (const [, uid, gid] of changeOwner.mock.calls) expect([uid, gid]).toEqual([10001, 10001]);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("fixture");
  });

  it("leaves engine-private files and similarly prefixed siblings untouched", () => {
    const secret = path.join(temporary, "workspace-private");
    writeFileSync(secret, "fixture");
    owner.publish(secret);
    owner.publish(root);
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("does not publish private state stored inside the checkout", () => {
    for (const name of [".git", ".zeros", ".ssh"]) {
      mkdirSync(path.join(root, name));
      const target = path.join(root, name, "private");
      writeFileSync(target, "fixture", { mode: 0o600 });
      owner.publish(target);
    }
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("keeps the writer's explicit Git exclude publication while recovery skips Git internals", () => {
    const exclude = path.join(root, ".git", "info", "exclude");
    mkdirSync(path.dirname(exclude), { recursive: true });
    writeFileSync(exclude, ".zeros/\n", { mode: 0o600 });
    const fd = openSync(exclude, "r");
    try { owner.publish(exclude, fd); }
    finally { closeSync(fd); }
    expect(changeOwner).toHaveBeenCalledTimes(3);
    changeOwner.mockClear();
    expect(owner.recover()).toMatchObject({ published: 0, skipped: 1 });
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("refuses symlink and hardlink aliases to private files", () => {
    const secret = path.join(temporary, "private");
    writeFileSync(secret, "fixture");
    const symbolic = path.join(root, "symbolic");
    const hard = path.join(root, "hard");
    symlinkSync(secret, symbolic);
    linkSync(secret, hard);
    expect(() => owner.publish(symbolic)).toThrow();
    expect(() => owner.publish(hard)).toThrow();
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("refuses an intermediate symlink even when the leaf is regular", () => {
    const privateDir = path.join(temporary, "private");
    mkdirSync(privateDir);
    writeFileSync(path.join(privateDir, "file"), "fixture");
    symlinkSync(privateDir, path.join(root, "alias"));
    expect(() => owner.publish(path.join(root, "alias", "file"))).toThrow();
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("uses an already-open descriptor for atomic writes", () => {
    const target = path.join(root, "file");
    const fd = openSync(target, "wx", 0o600);
    try {
      owner.publish(target, fd);
      expect(changeOwner).toHaveBeenCalledWith(fd, 10001, 10001);
    } finally { closeSync(fd); }
  });

  it("recovers admitted source while skipping private state, aliases and nested owners", () => {
    const source = path.join(root, "Design", "page.html");
    mkdirSync(path.dirname(source), { mode: 0o700 });
    writeFileSync(source, "fixture", { mode: 0o600 });
    for (const name of [".git", ".zeros", ".ssh", "private-state", "registered-owner", "nested-repo"]) {
      mkdirSync(path.join(root, name));
      writeFileSync(path.join(root, name, "private"), "fixture", { mode: 0o600 });
    }
    mkdirSync(path.join(root, "nested-repo", ".git"));
    mkdirSync(path.join(root, ".codex"));
    writeFileSync(path.join(root, ".codex", "auth.json"), "fixture", { mode: 0o600 });
    const privateFile = path.join(temporary, "private");
    writeFileSync(privateFile, "fixture", { mode: 0o600 });
    symlinkSync(privateFile, path.join(root, "symbolic"));
    linkSync(privateFile, path.join(root, "hard"));
    const published: string[] = [];
    changeOwner.mockImplementation((fd: number) => published.push(realpathSync(`/proc/self/fd/${fd}`)));
    const result = owner.recover({
      privateRoots: [path.join(root, "private-state")],
      ownerRoots: [root, path.join(root, "registered-owner")],
    });
    expect(published.sort()).toEqual([path.join(root, ".codex"), path.dirname(source), source].sort());
    expect(result).toMatchObject({ published: 3, failed: 0, bounded: false });
    expect(result.skipped).toBeGreaterThanOrEqual(9);
    expect(statSync(source).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(source)).mode & 0o777).toBe(0o700);
  });

  it("bounds recovery by entries and elapsed time", () => {
    for (let i = 0; i < 8; i++) writeFileSync(path.join(root, `${i}.txt`), "fixture");
    const entries = owner.recover({ maxEntries: 2 });
    expect(entries.visited).toBe(2);
    expect(entries.published).toBe(2);
    expect(entries.bounded).toBe(true);
    changeOwner.mockClear();
    const time = owner.recover({ maxDurationMs: 0 });
    expect(time).toMatchObject({ visited: 0, published: 0, bounded: true });
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("continues beyond the slice budget without revisiting its prefix or sharing private state", async () => {
    const expected = Array.from({ length: 8 }, (_, i) => path.join(root, `${i}.txt`));
    for (const file of expected) writeFileSync(file, "fixture", { mode: 0o600 });
    mkdirSync(path.join(root, ".zeros"));
    writeFileSync(path.join(root, ".zeros", "private"), "private fixture");
    const published: string[] = [];
    changeOwner.mockImplementation((fd: number) => published.push(realpathSync(`/proc/self/fd/${fd}`)));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    const result = await owner.recoverCompletely({ maxEntries: 2, maxDurationMs: 10_000 });
    expect(result).toMatchObject({ visited: 9, published: 8, skipped: 1, failed: 0, bounded: false });
    expect(published.sort()).toEqual(expected.sort());
    expect(yielded).toBe(true);
  });

  it("does not publish a directory that became a nested checkout during recovery", () => {
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    writeFileSync(path.join(nested, ".git"), "gitdir: elsewhere");
    writeFileSync(path.join(nested, "source"), "fixture");
    const result = owner.recover();
    expect(result).toMatchObject({ published: 0, skipped: 1, failed: 0 });
    expect(changeOwner).not.toHaveBeenCalled();
  });

  it("rechecks nested checkout admission after yielding a recovery slice", async () => {
    const nested = path.join(root, "nested");
    mkdirSync(nested);
    for (let i = 0; i < 5; i++) writeFileSync(path.join(nested, `${i}.txt`), "fixture");
    const published: string[] = [];
    changeOwner.mockImplementation((fd: number) => published.push(realpathSync(`/proc/self/fd/${fd}`)));
    // The first slice visits the directory and one file, then yields. A new
    // nested owner must prevent the retained cursor from publishing the rest.
    setImmediate(() => writeFileSync(path.join(nested, ".git"), "gitdir: elsewhere"));
    const result = await owner.recoverCompletely({ maxEntries: 2, maxDurationMs: 10_000 });
    expect(published.filter(file => file.endsWith(".txt"))).toHaveLength(1);
    expect(result).toMatchObject({ skipped: 1, failed: 0, bounded: false });
  });

  it("does not recover a checkout that is itself inside engine-private storage", () => {
    writeFileSync(path.join(root, "private"), "fixture");
    expect(owner.recover({ privateRoots: [temporary] })).toMatchObject({ visited: 0, published: 0 });
    expect(changeOwner).not.toHaveBeenCalled();
  });
});

describe("cloud workspace publication contract", () => {
  it("publishes the active v4 contract and never opts in Local or retired profiles", async () => {
    const { publishesCloudWorkspaceOwnership } = await import("../cloud-workspace-ownership");
    const { parseCloudWorkerConfiguration } = await import("../../agents/containment/cloud-worker-config");
    const source = readFileSync(path.join(__dirname, "../../../../../../scripts/cloud-workspace-validation/sandbox/cloud-worker.json"), "utf8");
    const active = parseCloudWorkerConfiguration(JSON.stringify({ ...JSON.parse(source), version: 4, profile: "zeros-cloud-worker-v4" }));
    expect(publishesCloudWorkspaceOwnership(active)).toBe(true);
    for (const version of [1, 2, 3]) expect(publishesCloudWorkspaceOwnership({ version })).toBe(false);
    expect(publishesCloudWorkspaceOwnership(null)).toBe(false);
    expect(publishesCloudWorkspaceOwnership(undefined)).toBe(false);
  });

  it("never scans or repairs Local and non-v4 deployments", async () => {
    const { recoverCloudWorkspaceOwnership } = await import("../cloud-workspace-ownership");
    for (const worker of [null, undefined]) {
      expect(await recoverCloudWorkspaceOwnership(worker)).toEqual({ visited: 0, published: 0, skipped: 0, failed: 0, bounded: false });
    }
  });
});
