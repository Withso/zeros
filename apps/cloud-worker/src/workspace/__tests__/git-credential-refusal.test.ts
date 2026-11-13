import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { commandRunner, GitCommandError, gitCommandError } from "../commands";
import { githubAuthenticationMessage, githubAuthenticationError } from "../../credentials/github-failure";

const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
const quit = (reason: Parameters<typeof githubAuthenticationError>[0]) =>
  `${githubAuthenticationMessage(githubAuthenticationError(reason))}\nfatal: credential helper '!/opt/zeros/git-credential' told us to quit\n`;

it("R1 §16: a broker refusal on a structured Git request carries its safe reason and copy, never stderr", () => {
  const cases = [
    ["connection-required", "credential_missing"], ["connection-expired", "credential_missing"], ["connection-changed", "credential_missing"],
    ["access-denied", "permission_denied"], ["installation-required", "permission_denied"], ["installation-suspended", "permission_denied"],
    ["sso-required", "permission_denied"], ["source-review-required", "permission_denied"], ["rate-limited", "network"], ["unavailable", "network"],
  ] as const;
  for (const [reason, detail] of cases) {
    const error = gitCommandError(quit(reason), null);
    expect([reason, error.detail]).toEqual([reason, detail]);
    expect(error.message).toBe(githubAuthenticationMessage(githubAuthenticationError(reason)));
    expect(error.message).not.toMatch(/told us to quit|\/opt\/zeros/);
  }
  // A helper that quit without one of our messages is still a missing credential, with the generic copy.
  expect(gitCommandError("fatal: credential helper '!x' told us to quit\n", null)).toMatchObject({ detail: "credential_missing" });
  expect(gitCommandError("fatal: unrelated failure\n", null)).toMatchObject({ detail: "other", message: "The Git command could not be completed. Check the repository state and try again." });
});

it("R1 §16: access denied says only the GitHub operation needs access", () => {
  expect(githubAuthenticationMessage(githubAuthenticationError("access-denied")))
    .toBe("Your GitHub account cannot access this repository, so pushing, fetching and pull requests need someone with access. Everything else in this workspace keeps working.");
});

it("real Git through the worker's runner: a quitting credential helper is reported as credential_missing with its message", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zeros-git-refusal-")); cleanups.push(directory);
  const helper = join(directory, "helper");
  await writeFile(helper, `#!/bin/sh\necho "${githubAuthenticationMessage(githubAuthenticationError("connection-required"))}" >&2\nprintf "quit=true\\n\\n"\nexit 1\n`);
  await chmod(helper, 0o755);
  const run = commandRunner(directory, { HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: `!${helper}` });
  const failure = await run("git", ["credential", "fill"], { input: "protocol=https\nhost=github.com\n\n" }).catch(error => error);
  expect(failure).toBeInstanceOf(GitCommandError);
  expect(failure).toMatchObject({ code: "GIT_COMMAND_FAILED", detail: "credential_missing", message: "Reconnect GitHub in Zeros: connect an account for this organization." });
});
