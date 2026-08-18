import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const dispatcher = path.resolve(
  __dirname,
  "../../../../../../..",
  "binaries/zsr-git-dispatch",
);

/** The compiled dispatcher is built by `xcrun clang`, so it only exists where it
 * can be built. Everything it decides is otherwise unobserved by the suite: the
 * collection tests cover the engine's half (what is installed and what the
 * configuration says) on every platform, and this covers the binary's half. */
describe.skipIf(process.platform !== "darwin" || !existsSync(dispatcher))(
  "compiled shadow-Git dispatcher",
  () => {
    let root: string;
    let workspace: string;
    let tools: string;
    let config: string;

    beforeEach(async () => {
      // Canonical from the start: the dispatcher resolves the working directory,
      // and on macOS `/var` is a symlink, so a lexical temp path would never
      // match the workspace root it is compared against.
      root = await realpath(
        await mkdtemp(path.join(tmpdir(), "zeros-git-dispatch-")),
      );
      workspace = path.join(root, "workspace");
      tools = path.join(root, "tools");
      config = path.join(tools, "git-dispatch.conf");
      await mkdir(path.join(workspace, "sub"), { recursive: true });
      await mkdir(path.join(workspace, "nested", ".git"), { recursive: true });
      await mkdir(tools, { recursive: true });
      // A real shadow projection leaves the primary workspace's `.git` a
      // DIRECTORY and redirects Git through GIT_DIR in the child environment;
      // the regular-file shape belongs to a linked worktree.
      await mkdir(path.join(workspace, ".git"), { recursive: true });
      // Stand-ins that report which route was taken and what they were handed.
      await writeFile(
        path.join(tools, "client"),
        '#!/bin/sh\necho "CLIENT|$(pwd)|$*|${GIT_DIR-unset}|${GIT_CONFIG_COUNT-unset}|${PATH%%:*}"\n',
        { mode: 0o555 },
      );
      await chmod(path.join(tools, "client"), 0o555);
      await writeFile(
        path.join(tools, "dispatcher.mjs"),
        'console.log("DELEGATED|" + process.argv.slice(2).join(" "));\n',
      );
      await writeFile(
        path.join(tools, "git"),
        '#!/bin/sh\necho "NATIVE|$(pwd)|$*|${GIT_DIR-unset}|${GIT_INDEX_FILE-unset}|${ZEROS_ZSR_MACOS_GIT_INTERPOSE_BYPASS-unset}"\n',
        { mode: 0o555 },
      );
      await chmod(path.join(tools, "git"), 0o555);
      await writeConfig(1);
    });

    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    async function writeConfig(entries: number) {
      const lines = [
        "v1",
        `runtime ${process.execPath}`,
        `dispatcher ${path.join(tools, "dispatcher.mjs")}`,
      ];
      for (let index = 0; index < entries; index += 1) {
        lines.push(
          "entry",
          `workspaceRoot ${workspace}`,
          `gitEntry ${path.join(workspace, ".git")}`,
          `shadowRoot ${path.join(root, "shadow")}`,
          `toolsRoot ${tools}`,
          `client ${path.join(tools, "client")}`,
          `git ${path.join(tools, "git")}`,
          `env GIT_DIR=${path.join(root, "shadow")}`,
          `env GIT_INDEX_FILE=${path.join(root, "shadow", "index")}`,
        );
      }
      await rm(config, { force: true });
      await writeFile(config, `${lines.join("\n")}\n`, { mode: 0o400 });
    }

    async function dispatch(
      cwd: string,
      args: readonly string[],
      env: Record<string, string> = {},
    ) {
      const { stdout } = await run(dispatcher, [...args], {
        cwd,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ZEROS_ZSR_GIT_DISPATCH_CONFIG: config,
          // What a contained child actually carries: the entry's own GIT_DIR.
          GIT_DIR: path.join(root, "shadow"),
          ...env,
        },
      });
      return stdout.trim();
    }

    it("runs an unbrokered operation as the real Git, never the client", async () => {
      // `git-client.mjs` already runs these natively; its runtime start buys
      // nothing but the decision, which is made here instead.
      const result = await dispatch(path.join(workspace, "sub"), ["status"], {
        GIT_CONFIG_COUNT: "9",
      });
      const [route, cwd, args, gitDir, indexFile, bypass] = result.split("|");
      expect(route).toBe("NATIVE");
      expect(cwd).toBe(path.join(workspace, "sub"));
      expect(args).toBe("status");
      expect(gitDir).toBe(path.join(root, "shadow"));
      expect(indexFile).toBe(path.join(root, "shadow", "index"));
      // Without the one-hop bypass the interposer would send this straight back.
      expect(bypass).toBe("1");
    });

    it.each([
      ["push"],
      ["fetch"],
      ["pull"],
      ["checkout"],
      ["reset"],
      ["clean"],
      ["rm"],
      ["mv"],
      ["stash"],
      ["merge"],
      ["rebase"],
      ["cherry-pick"],
      ["revert"],
      ["switch"],
      ["restore"],
    ])(
      "sends %s to the client, because the broker owns it",
      async (operation) => {
        // Twelve of these fifteen are Design protection rather than network
        // operations, so this list is a fence and not an optimisation boundary.
        const result = await dispatch(workspace, [operation]);
        expect(result.split("|")[0]).toBe("CLIENT");
      },
    );

    it("lets the client decide a brokered operation carrying --help", async () => {
      // The client forces native for --help; letting it make that call keeps one
      // decision in one place.
      expect(
        (await dispatch(workspace, ["push", "--help"])).split("|")[0],
      ).toBe("NATIVE");
    });

    it("drops the primary index override for git worktree", async () => {
      const result = await dispatch(path.join(workspace, "sub"), [
        "worktree",
        "add",
        "x",
      ]);
      const [route, , , gitDir, indexFile] = result.split("|");
      expect(route).toBe("NATIVE");
      expect(gitDir).toBe(path.join(root, "shadow"));
      // A worktree must build its own index; keeping the primary override can
      // produce a first commit that silently omits unmaterialized paths.
      expect(indexFile).toBe("unset");
    });

    it("refuses to answer when the caller could be in a linked worktree", async () => {
      // A regular `.git` is the shape the client inspects to decide whether to
      // drop the private overrides. This does not reproduce that decision.
      await writeFile(
        path.join(workspace, "sub", ".git"),
        `gitdir: ${path.join(root, "shadow", "worktrees", "x")}\n`,
      );
      const result = await dispatch(path.join(workspace, "sub"), ["status"]);
      expect(result.split("|")[0]).toBe("DELEGATED");
    });

    it("applies -C to the working directory and drops it from the command", async () => {
      const result = await dispatch(root, ["-C", workspace, "status"]);
      const [route, cwd, args] = result.split("|");
      expect(route).toBe("NATIVE");
      expect(cwd).toBe(workspace);
      expect(args).toBe("status");
    });

    it("passes a pathspec separator through once a subcommand has been seen", async () => {
      const result = await dispatch(workspace, ["log", "--", "file"]);
      expect(result.split("|")[0]).toBe("NATIVE");
      expect(result.split("|")[2]).toBe("log -- file");
    });

    it.each([
      ["a nested repository owns the directory", "nested", ["status"], {}],
      ["an explicit --git-dir", ".", ["--git-dir=/elsewhere", "status"], {}],
      ["an explicit --work-tree", ".", ["--work-tree", "/x", "status"], {}],
      [
        "an ambient GIT_DIR the entry did not set",
        ".",
        ["status"],
        { GIT_DIR: "/elsewhere" },
      ],
    ])("delegates when %s", async (_case, directory, args, env) => {
      const result = await dispatch(
        path.resolve(workspace, directory),
        args as string[],
        env as Record<string, string>,
      );
      expect(result.split("|")[0]).toBe("DELEGATED");
    });

    it("delegates from outside every workspace", async () => {
      expect((await dispatch(root, ["status"])).split("|")[0]).toBe(
        "DELEGATED",
      );
    });

    it("delegates rather than choosing between repositories", async () => {
      await writeConfig(2);
      expect((await dispatch(workspace, ["status"])).split("|")[0]).toBe(
        "DELEGATED",
      );
    });

    it("delegates when the configuration is unreadable", async () => {
      await rm(config, { force: true });
      await writeFile(config, "v1\nrubbish\n", { mode: 0o400 });
      // A configuration with no runtime cannot even delegate, and must fail
      // loudly rather than run Git with no repository selected at all.
      await expect(dispatch(workspace, ["status"])).rejects.toMatchObject({
        code: 127,
      });
    });
  },
);
