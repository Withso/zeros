import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { commandRunner } from "../commands";
import { reconcileGithubRemote } from "../github-remote";
import { repositoryFixture } from "./repository-fixture";

const binding = {
  repositoryId: "42",
  repository: "current/renamed",
  previousRepositories: ["former/project"],
};
it.each([
  [
    "https://github.com/former/project.git",
    "https://github.com/current/renamed.git",
  ],
  ["git@github.com:former/project.git", "git@github.com:current/renamed.git"],
  [
    "ssh://git@github.com:22/former/project",
    "ssh://git@github.com:22/current/renamed",
  ],
])(
  "repairs %s without moving the checkout or its branch",
  async (before, after) => {
    const { root, git } = await repositoryFixture();
    await git("remote", "add", "origin", before);
    await git("config", "--add", "remote.origin.pushurl", before);
    await git(
      "config",
      "--add",
      "remote.origin.pushurl",
      "git@github.com:fork/project.git",
    );
    await writeFile(join(root, "readme.txt"), "unsaved work\n");
    expect(
      await reconcileGithubRemote(root, binding, commandRunner(root)),
    ).toBe(true);
    expect(await git("remote", "get-url", "origin")).toBe(after);
    expect(await git("remote", "get-url", "--push", "--all", "origin")).toBe(
      `${after}\ngit@github.com:fork/project.git`,
    );
    expect(await git("config", "--get", "remote.origin.fetch")).toBe(
      "+refs/heads/*:refs/remotes/origin/*",
    );
    expect(await git("branch", "--show-current")).toBe("workspace/fixture");
    expect(await readFile(join(root, "readme.txt"), "utf8")).toBe(
      "unsaved work\n",
    );
  },
);

it("preserves deliberate destinations, extra fetch URLs, URL rewrites and credential-bearing URLs", async () => {
  for (const variant of ["foreign", "multiple", "rewrite", "credential"]) {
    const { root, git } = await repositoryFixture();
    await git(
      "remote",
      "add",
      "origin",
      variant === "foreign"
        ? "https://github.com/another/project.git"
        : variant === "credential"
          ? "https://user:private@github.com/former/project.git"
          : "https://github.com/former/project.git",
    );
    if (variant === "multiple")
      await git(
        "config",
        "--add",
        "remote.origin.url",
        "https://github.com/another/project.git",
      );
    if (variant === "rewrite")
      await git(
        "config",
        "url.https://example.test/.insteadOf",
        "https://github.com/",
      );
    const before = await readFile(join(root, ".git/config"), "utf8");
    expect(
      await reconcileGithubRemote(root, binding, commandRunner(root)),
    ).toBe(false);
    expect(await readFile(join(root, ".git/config"), "utf8")).toBe(before);
  }
});

it("retains a terminal configuration change that races remote repair", async () => {
  const { root, git } = await repositoryFixture(),
    run = commandRunner(root);
  await git("remote", "add", "origin", "https://github.com/former/project.git");
  let changed = false;
  const racing: typeof run = async (program, args, options) => {
    const result = await run(program, args, options);
    if (!changed && args.includes("--list")) {
      changed = true;
      await git(
        "remote",
        "set-url",
        "origin",
        "https://github.com/another/project.git",
      );
    }
    return result;
  };
  expect(await reconcileGithubRemote(root, binding, racing)).toBe(false);
  expect(await git("remote", "get-url", "origin")).toBe(
    "https://github.com/another/project.git",
  );
});

it("never repairs a binding that was retired while Git was reading", async () => {
  const { root, git } = await repositoryFixture(),
    run = commandRunner(root);
  await git("remote", "add", "origin", "https://github.com/former/project.git");
  let current = true;
  const racing: typeof run = async (...args) => {
    const result = await run(...args);
    current = false;
    return result;
  };
  expect(
    await reconcileGithubRemote(root, binding, racing, () => current),
  ).toBe(false);
  expect(await git("remote", "get-url", "origin")).toBe(
    "https://github.com/former/project.git",
  );
});
