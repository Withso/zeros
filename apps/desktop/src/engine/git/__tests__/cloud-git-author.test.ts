import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGit } from "../git-exec";
import { cloudGitAuthorEnvironment, needsCloudGitAuthor, runWithCloudGitAuthor, scopedCloudGitAuthorEnvironment } from "../cloud-git-author";

const first = { name: "Member A", email: "1234+member-a@users.noreply.github.com" };
const second = { name: "Member B", email: "5678+member-b@users.noreply.github.com" };
describe("cloud Git author scope", () => {
  it("attributes explicit Design lifecycle commits to the admitted member", () => {
    expect(needsCloudGitAuthor("design.renameDirectory")).toBe(true);
    expect(needsCloudGitAuthor("design.removeDirectory")).toBe(true);
    expect(needsCloudGitAuthor("design.createDirectory")).toBe(false);
    expect(needsCloudGitAuthor("design.selectDirectory")).toBe(false);
  });
  it("commits without VM Git configuration and preserves authors during amend", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "zeros-author-"));
    const exec = promisify(execFile);
    try {
      await exec("git", ["init", "-q", dir]);
      await runWithCloudGitAuthor(first, () => true, () => runGit(dir, ["commit", "--allow-empty", "-m", "Member A commit"]));
      await runWithCloudGitAuthor(second, () => true, () => runGit(dir, ["commit", "--amend", "--allow-empty", "-m", "Member B amend"]));
      expect((await exec("git", ["-C", dir, "show", "-s", "--format=%an%n%ae%n%cn%n%ce"])).stdout.trim()).toBe(
        `${first.name}\n${first.email}\n${second.name}\n${second.email}`,
      );
      const config = (await exec("git", ["-C", dir, "config", "--local", "--list"])).stdout;
      expect(config).not.toContain("user.name="); expect(config).not.toContain("user.email=");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("isolates concurrent members and leaves Local invocations untouched", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = runWithCloudGitAuthor(first, () => true, async () => { await gate; return scopedCloudGitAuthorEnvironment(); });
    expect(scopedCloudGitAuthorEnvironment()).toEqual({});
    expect(await runWithCloudGitAuthor(second, () => true, async () => scopedCloudGitAuthorEnvironment())).toEqual(cloudGitAuthorEnvironment(second));
    release(); expect(await pending).toEqual(cloudGitAuthorEnvironment(first));
    expect(scopedCloudGitAuthorEnvironment()).toEqual({});
  });
  it("does not inherit an ambient identity when the member has no connection", () => {
    expect(cloudGitAuthorEnvironment(null)).toEqual({ GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" });
  });
  it("rejects invalid wire identities and revoked scope", async () => {
    expect(() => cloudGitAuthorEnvironment({ ...first, email: "personal@example.test" })).toThrow();
    expect(() => cloudGitAuthorEnvironment({ ...first, name: "Bad\nName" })).toThrow();
    let active = true;
    await runWithCloudGitAuthor(first, () => active, async () => {
      active = false; expect(() => scopedCloudGitAuthorEnvironment()).toThrow();
    });
  });
  it("retires inherited async scopes even after the request fails", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let late!: Promise<unknown>;
    await expect(runWithCloudGitAuthor(first, () => true, async () => {
      late = gate.then(() => expect(() => scopedCloudGitAuthorEnvironment()).toThrow());
      throw new Error("test failure");
    })).rejects.toThrow("test failure");
    release(); await late;
  });
});
