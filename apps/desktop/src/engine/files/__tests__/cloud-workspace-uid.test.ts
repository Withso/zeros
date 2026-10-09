import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as ownership from "../cloud-workspace-ownership";
import { QualifiedCloudFilePolicy } from "../cloud-file-policy";
import { writeWorkspaceFile } from "../write-file";
import { gitProcessOptions } from "../../git/git-execution-identity";

vi.mock("../../agents/containment/cloud-worker-config",()=>({
  loadCloudWorkerConfiguration:()=>({version:4,uid:10001,gid:10001}), // Archived base account is placement, not launch identity.
}));

describe.runIf(process.platform === "linux")("same-engine cloud checkout", () => {
  it("allows same-engine Files, Design source and Git after writes and bounded recovery", async () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-cloud-owner-uid-"));
    const root = path.join(temporary, "workspace");
    fs.mkdirSync(root, { mode: 0o700 });
    const git = (...args:string[])=>execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@example.test","-c","commit.gpgsign=false","-c",`core.hooksPath=${temporary}/no-hooks`,...args],{
      cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"],...gitProcessOptions({PATH:"/usr/bin:/bin",HOME:temporary,LANG:"C.UTF-8",GIT_OPTIONAL_LOCKS:"0"}),
    });
    const publisher = new ownership.CloudWorkspaceOwnership(root);
    const previousMask = process.umask(0o077);
    try {
      git("init", "-q", "-b", "main");
      for (const [name, mode] of [["README.md", 0o600], ["run.sh", 0o755]] as const) {
        const target = path.join(root, name);
        fs.writeFileSync(target, "original\n", { mode });
        fs.chmodSync(target, mode);
      }
      git("add", "--", "README.md", "run.sh");
      git("commit", "-q", "-m", "Initial fixture");
      vi.spyOn(ownership, "publishCloudWorkspacePath").mockImplementation((target, fd) => {
        publisher.publish(target, fd);
      });
      const cloudPolicy = new QualifiedCloudFilePolicy(root, { canEdit: true, authorized: () => true, privateRoots: [], ownerRoots: () => [] });
      for (const [name, contents] of [["README.md", "updated\n"], ["run.sh", "updated script\n"], ["Design/nested/page.html", "<p>new</p>\n"]] as const) {
        expect(writeWorkspaceFile(root, name, contents, { remote: true, cloudPolicy })).toMatchObject({ kind: "success" });
        expect(fs.statSync(path.join(root, name)).uid).toBe(process.geteuid!());
        expect(fs.readFileSync(path.join(root,name),"utf8")).toBe(contents);
      }
      expect(fs.statSync(path.join(root, "run.sh")).mode & 0o777).toBe(0o755);
      expect(fs.statSync(path.join(root, "Design/nested/page.html")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(root, "Design/nested")).mode & 0o777).toBe(0o700);

      // Atomic source replacement remains visible to same-user Git without chown.
      fs.writeFileSync(path.join(root, "polluted.tmp"), "old engine write\n", { mode: 0o600 });
      fs.renameSync(path.join(root, "polluted.tmp"), path.join(root, "README.md"));
      const privateRoot = path.join(root, ".zeros");
      fs.mkdirSync(privateRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(privateRoot, "private"), "fixture", { mode: 0o600 });
      expect(git("diff", "--stat", "HEAD")).toContain("README.md");
      const result = publisher.recover();
      expect(result).toMatchObject({ published: 0, failed: 0, bounded: false });
      expect(fs.statSync(path.join(root, "README.md")).uid).toBe(process.geteuid!());
      expect(fs.statSync(path.join(root, "README.md")).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(privateRoot,"private")).uid).toBe(process.geteuid!());
      expect(publisher.recover()).toMatchObject({ published: 0, failed: 0 });
      expect(git("diff", "--stat", "HEAD")).toContain("README.md");
      git("add", "--", "README.md", "run.sh", "Design/nested/page.html");
      git("commit", "-q", "-m", "Publish engine writes");
      expect(git("show", "HEAD:Design/nested/page.html")).toBe("<p>new</p>\n");
      const later = path.join(root, "later");
      fs.mkdirSync(later, { mode: 0o700 });
      for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(later, `${i}.txt`), "later source\n", { mode: 0o600 });
      const complete = await publisher.recoverCompletely({ maxEntries: 2, maxDurationMs: 10_000 });
      expect(complete).toMatchObject({ published: 0, skipped: 2, failed: 0, bounded: false });
      for (let i = 0; i < 8; i++) {
        expect(fs.readFileSync(path.join(later,`${i}.txt`),"utf8")).toBe("later source\n");
        expect(fs.statSync(path.join(later, `${i}.txt`)).mode & 0o777).toBe(0o600);
      }
      expect(fs.statSync(later).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(privateRoot,"private")).uid).toBe(process.geteuid!());
      git("add", "--", "later");
      git("commit", "-q", "-m", "Publish later recovery slices");
    } finally {
      vi.restoreAllMocks();
      process.umask(previousMask);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }, 70_000);
});
