import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as ownership from "../cloud-workspace-ownership";
import { QualifiedCloudFilePolicy } from "../cloud-file-policy";
import { writeWorkspaceFile } from "../write-file";
import { parseCloudWorkerConfiguration } from "../../agents/containment/cloud-worker-config";

// The parent suite stays unprivileged. Only this disposable fixture is rerun
// under sudo when available, with a fresh environment and no Alpha credentials.
const privileged = process.geteuid?.() === 0;
let canSwitchUid = false;
if (process.platform === "linux") {
  try {
    const args = ["--reuid=10001", "--regid=10001", "--clear-groups", "/usr/bin/id", "-u"];
    const uid = execFileSync(privileged ? "/usr/bin/setpriv" : "sudo", privileged ? args : ["-n", "/usr/bin/setpriv", ...args], {
      encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    });
    canSwitchUid = uid.trim() === "10001";
  } catch { /* explicit skipped suite below when UID switching is unavailable */ }
}

describe.skipIf(!canSwitchUid)("Linux worker UID fixture (requires root/setpriv; skipped when UID switching is unavailable)", () => {
  it("allows worker read, Git diff and commit after engine writes and bounded recovery", async () => {
    if (!privileged) {
      const output = execFileSync("sudo", [
        "-n", process.execPath, path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.config.ts",
        path.relative(process.cwd(), __filename), "--maxWorkers=1",
      ], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000, maxBuffer: 512_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), LANG: "C.UTF-8" },
      });
      expect(output).toContain("1 passed");
      return;
    }

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-owner-uid-"));
    fs.chownSync(temporary, 10001, 10001);
    const root = path.join(temporary, "workspace");
    fs.mkdirSync(root, { mode: 0o700 });
    fs.chownSync(root, 10001, 10001);
    const worker = (...args: string[]) => execFileSync("/usr/bin/setpriv", [
      "--reuid=10001", "--regid=10001", "--clear-groups", ...args,
    ], { cwd: root, encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: temporary, LANG: "C.UTF-8", GIT_OPTIONAL_LOCKS: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    const git = (...args: string[]) => worker("/usr/bin/git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${temporary}/no-hooks`, ...args);
    const publisher = new ownership.CloudWorkspaceOwnership(root, { uid: 10001, gid: 10001 });
    const marker = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../../../../scripts/cloud-workspace-validation/sandbox/cloud-worker.json"), "utf8"));
    const profile = parseCloudWorkerConfiguration(JSON.stringify({ ...marker, version: 4, profile: "zeros-cloud-worker-v4" }));
    const previousMask = process.umask(0o077);
    try {
      git("init", "-q", "-b", "main");
      for (const [name, mode] of [["README.md", 0o600], ["run.sh", 0o755]] as const) {
        const target = path.join(root, name);
        fs.writeFileSync(target, "original\n", { mode });
        fs.chmodSync(target, mode);
        fs.chownSync(target, 10001, 10001);
      }
      git("add", "--", "README.md", "run.sh");
      git("commit", "-q", "-m", "Initial fixture");
      vi.spyOn(ownership, "publishCloudWorkspacePath").mockImplementation((target, fd) => {
        if (ownership.publishesCloudWorkspaceOwnership(profile)) publisher.publish(target, fd);
      });
      const cloudPolicy = new QualifiedCloudFilePolicy(root, { canEdit: true, authorized: () => true, privateRoots: [], ownerRoots: () => [] });
      for (const [name, contents] of [["README.md", "updated\n"], ["run.sh", "updated script\n"], ["Design/nested/page.html", "<p>new</p>\n"]] as const) {
        expect(writeWorkspaceFile(root, name, contents, { remote: true, cloudPolicy })).toMatchObject({ kind: "success" });
        expect(fs.statSync(path.join(root, name)).uid).toBe(10001);
        expect(worker("/usr/bin/cat", path.join(root, name))).toBe(contents);
      }
      expect(fs.statSync(path.join(root, "run.sh")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(root, "Design/nested/page.html")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, "Design/nested")).mode & 0o777).toBe(0o700);

      // Simulate bytes produced before the v4 publication fix.
      fs.writeFileSync(path.join(root, "polluted.tmp"), "old engine write\n", { mode: 0o600 });
      fs.renameSync(path.join(root, "polluted.tmp"), path.join(root, "README.md"));
      const privateRoot = path.join(root, ".zeros");
      fs.mkdirSync(privateRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(privateRoot, "private"), "fixture", { mode: 0o600 });
      expect(() => git("diff", "--stat", "HEAD")).toThrow();
      const result = publisher.recover();
      expect(result).toMatchObject({ published: 1, failed: 0, bounded: false });
      expect(fs.statSync(path.join(root, "README.md")).uid).toBe(10001);
      expect(fs.statSync(path.join(root, "README.md")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(privateRoot, "private")).uid).toBe(0);
      expect(publisher.recover()).toMatchObject({ published: 0, failed: 0 });
      expect(git("diff", "--stat", "HEAD")).toContain("README.md");
      git("add", "--", "README.md", "run.sh", "Design/nested/page.html");
      git("commit", "-q", "-m", "Publish engine writes");
      expect(git("show", "HEAD:Design/nested/page.html")).toBe("<p>new</p>\n");
      const foreign = path.join(root, "third-owner");
      fs.writeFileSync(foreign, "fixture", { mode: 0o600 });
      fs.chownSync(foreign, 10004, 10004);
      expect(() => publisher.publish(foreign)).toThrow("Unexpected cloud checkout file owner");
      expect(publisher.recover()).toMatchObject({ published: 0, skipped: 3, failed: 0 });
      expect(fs.statSync(foreign).uid).toBe(10004);
      const later = path.join(root, "later");
      fs.mkdirSync(later, { mode: 0o700 });
      for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(later, `${i}.txt`), "later source\n", { mode: 0o600 });
      const complete = await publisher.recoverCompletely({ maxEntries: 2, maxDurationMs: 10_000 });
      expect(complete).toMatchObject({ published: 9, skipped: 3, failed: 0, bounded: false });
      for (let i = 0; i < 8; i++) {
        expect(worker("/usr/bin/cat", path.join(later, `${i}.txt`))).toBe("later source\n");
        expect(fs.statSync(path.join(later, `${i}.txt`)).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(later).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(privateRoot, "private")).uid).toBe(0);
      expect(fs.statSync(foreign).uid).toBe(10004);
      git("add", "--", "later");
      git("commit", "-q", "-m", "Publish later recovery slices");
    } finally {
      vi.restoreAllMocks();
      process.umask(previousMask);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 70_000);
});
