import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commandRunner, gitFailureDetail } from "../commands";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

it("names a failed Git command's cause as a closed detail, never its stderr, URL or token", () => {
  const cases: Array<[string, string]> = [
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "credential_missing"],
    ["remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/o/r.git/'", "auth_rejected"],
    ["remote: Permission to o/r.git denied to alex.\nfatal: unable to access 'https://github.com/o/r.git/': The requested URL returned error: 403", "permission_denied"],
    ["remote: Write access to repository not granted.\nfatal: unable to access …: The requested URL returned error: 403", "permission_denied"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/o/r.git/' not found", "repository_not_found"],
    [" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", "remote_rejected"],
    ["remote: error: GH006: Protected branch update failed for refs/heads/main.", "protected_branch"],
    [" ! [remote rejected] main -> main (pre-receive hook declined)", "hook_declined"],
    ["fatal: unable to access 'https://github.com/o/r.git/': Could not resolve host: github.com", "network"],
    ["fatal: something else entirely ghp_secret", "other"],
  ];
  for (const [stderr, detail] of cases) expect(gitFailureDetail(stderr, { killed: false })).toBe(detail);
  expect(gitFailureDetail("", { killed: true, signal: "SIGTERM" })).toBe("timeout");
});

it("attaches the detail to GIT_COMMAND_FAILED from a real push", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-git-detail-")); directories.push(directory);
  const remote = join(directory, "remote.git"), one = join(directory, "one"), two = join(directory, "two");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.test", ...args], { cwd, stdio: "ignore" });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  for (const clone of [one, two]) execFileSync("git", ["clone", "-q", remote, clone], { stdio: "ignore" });
  git(one, "commit", "-q", "--allow-empty", "-m", "one"); git(one, "push", "-q", "origin", "HEAD:main");
  git(two, "commit", "-q", "--allow-empty", "-m", "two");
  const error = await commandRunner(two)("git", ["push", "origin", "HEAD:main"]).catch((value: unknown) => value);
  expect(error).toMatchObject({ code: "GIT_COMMAND_FAILED", detail: "remote_rejected" });
});
