import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import {
  nativeGithubQualification,
  NativeGithubEvidence,
} from "../cloud-workspace-validation/lib/native-github-qualification";
it("requires an explicit write flag, test repository and connected-account Git commands", () => {
  expect(nativeGithubQualification({})).toBeNull();
  expect(() =>
    nativeGithubQualification({ ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE: "1" }),
  ).toThrow();
  expect(() =>
    nativeGithubQualification({
      ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE: "1",
      ZEROS_CLOUD_NATIVE_GITHUB_TEST_REPOSITORY: "org/repo;bad",
    }),
  ).toThrow();
  const plan = nativeGithubQualification({
    ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE: "1",
    ZEROS_CLOUD_NATIVE_GITHUB_TEST_REPOSITORY: "test-org/repo",
  })!;
  expect(plan.agentCommand).toContain("git push --set-upstream origin");
  expect(plan.agentCommand).toContain("git fetch origin");
  expect(plan.agentCommand).not.toMatch(/gh pr|gh api/);
  expect(plan.agentCommand).toContain("command -v gh >/dev/null 2>&1; then exit 1; fi");
  expect(plan.agentCommand).not.toContain("--delete");
  const evidence = new NativeGithubEvidence(plan.agentCommand);
  expect(() => evidence.assert()).toThrow();
  evidence.observe({
    sessionUpdate: "tool_call",
    toolCallId: "id",
    nativeToolCallId: "native",
    kind: "execute",
    rawInput: { command: plan.agentCommand },
    status: "completed",
  });
  expect(() => evidence.assert()).not.toThrow();
});

it.each(["agentCommand", "terminalCommand"] as const)("refuses %s before push if gh is present", async command => {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-github-qualification-"));
  try {
    await writeFile(path.join(root, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    await writeFile(path.join(root, "git"), `#!/bin/sh
case "$1" in
  remote) echo https://github.com/test/repo.git;;
  symbolic-ref) echo topic;;
  push) touch "$ZEROS_TEST_PUSH_MARKER";;
  switch|fetch) :;;
  *) exit 1;;
esac
`, { mode: 0o700 });
    const plan = nativeGithubQualification({ ZEROS_CLOUD_NATIVE_GITHUB_WRITE_SMOKE: "1", ZEROS_CLOUD_NATIVE_GITHUB_TEST_REPOSITORY: "test/repo" })!;
    const marker = path.join(root, "push");
    const result = await promisify(execFile)("/bin/bash", ["-c", plan[command]], {
      env: { PATH: `${root}:/usr/bin:/bin`, HOME: root, ZEROS_TEST_PUSH_MARKER: marker }, timeout: 3000,
    }).then(() => 0, (error: { code: number }) => error.code);
    expect(await access(marker).then(() => true, () => false)).toBe(false);
    expect(result).not.toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
