import { closeSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
});

describe("cloud workspace publication contract", () => {
  it("publishes engine-authored files for every isolated worker profile, including the shipped image's", async () => {
    const { publishesCloudWorkspaceOwnership } = await import("../cloud-workspace-ownership");
    const { parseCloudWorkerConfiguration } = await import("../../agents/containment/cloud-worker-config");
    const source = readFileSync(path.join(__dirname, "../../../../../../scripts/cloud-workspace-validation/sandbox/cloud-worker.json"), "utf8");
    const shipped = parseCloudWorkerConfiguration(source);
    expect(publishesCloudWorkspaceOwnership(shipped)).toBe(true);
    const variant = (version: number, profile: string) => parseCloudWorkerConfiguration(JSON.stringify({ ...JSON.parse(source), version, profile }));
    expect(publishesCloudWorkspaceOwnership(variant(2, "zeros-cloud-worker-v2"))).toBe(true);
    expect(publishesCloudWorkspaceOwnership(variant(1, "zeros-cloud-worker-v1"))).toBe(false);
    expect(publishesCloudWorkspaceOwnership(null)).toBe(false);
  });
});
