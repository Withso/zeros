import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFile } from "../../../git/git-exec";
import { sessionsRoot } from "../../session-paths";
import type { AgentFilesystemTerritory } from "../../types";
import { ShadowGitCollection } from "../shadow-git-collection";
import { discoverCanonicalGitRepository } from "../shadow-git";
import { newTerritoryGeneration } from "../status";

async function git(
  cwd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
): Promise<string> {
  return (
    await runFile("git", [...args], {
      cwd,
      env: env ? { ...process.env, ...env } : undefined,
      timeoutMs: 30_000,
    })
  ).stdout.trim();
}

describe("multi-repository ZSR shadow Git", () => {
  let root: string;
  let primary: string;
  let secondary: string;
  let primaryDesign: string;
  let secondaryDesign: string;
  let collection: ShadowGitCollection | null;

  async function createRepository(name: string): Promise<string> {
    const workspace = path.join(root, name);
    const design = path.join(workspace, "Zeros Design");
    await mkdir(design, { recursive: true });
    await git(workspace, ["init", "-b", "main"]);
    await git(workspace, ["config", "user.name", "Zeros Test"]);
    await git(workspace, ["config", "user.email", "zeros@example.invalid"]);
    await Promise.all([
      writeFile(path.join(workspace, "code.txt"), `${name} before\n`),
      writeFile(path.join(design, "document.json"), '{"safe":true}\n'),
    ]);
    await git(workspace, ["add", "--", "code.txt", "Zeros Design"]);
    await git(workspace, ["commit", "-m", "initial"]);
    return workspace;
  }

  beforeEach(async () => {
    // Canonical: everything downstream resolves paths, and on macOS `/var` is a
    // symlink to `/private/var`, so a lexical temp root makes every comparison
    // against a resolved path fail. This suite had only ever run on Linux.
    root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-shadow-git-set-")),
    );
    primary = await createRepository("primary");
    secondary = await createRepository("secondary");
    primaryDesign = path.join(primary, "Zeros Design");
    secondaryDesign = path.join(secondary, "Zeros Design");
    collection = null;
  });

  afterEach(async () => {
    await collection?.stop();
    await rm(root, { recursive: true, force: true });
  });

  async function startCollection(
    options: {
      shadowRoot?: string;
      generation?: ReturnType<typeof newTerritoryGeneration>;
      onPhase?: (name: string, ms: number) => void;
      gitDispatchBinary?: string;
    } = {},
  ): Promise<ShadowGitCollection> {
    const repositories = await Promise.all(
      [primary, secondary].map(discoverCanonicalGitRepository),
    );
    if (repositories.some((repository) => !repository)) {
      throw new Error("test repository was not discovered");
    }
    const territory: AgentFilesystemTerritory = {
      agentRole: "code",
      workspaceRoot: primary,
      designDirectory: primaryDesign,
      protectedDesignDirectories: [primaryDesign, secondaryDesign],
      designRecognitionPaths: [],
      writeCapabilities: {
        workspace: "write",
        deniedPaths: [
          primaryDesign,
          path.join(primary, ".git"),
          secondaryDesign,
          path.join(secondary, ".git"),
        ],
      },
    };
    const active = await ShadowGitCollection.create({
      repositories: repositories.filter(
        (repository): repository is NonNullable<typeof repository> =>
          repository !== null,
      ),
      additionalWriteRoots: [secondary],
      shadowRoot: options.shadowRoot ?? path.join(root, "private", "git"),
      privateHome: path.join(root, "private", "home"),
      commandsRoot: path.join(root, "private", "commands"),
      toolsRoot: path.join(root, "private", "tools"),
      toolRuntime: process.execPath,
      generation: options.generation ?? newTerritoryGeneration(),
      territory,
      ...(options.onPhase ? { onPhase: options.onPhase } : {}),
      ...(options.gitDispatchBinary
        ? { gitDispatchBinary: options.gitDispatchBinary }
        : {}),
    });
    collection = active;
    return active;
  }

  it("reports build phases summed across every repository", async () => {
    // `private-git` was 509-2585ms in the 2026-08-17 measurements and had never
    // been split, which is how the canary stayed a mystery for two rounds. Two
    // repositories are built here, so each phase must be reported for both and
    // summed — the useful question for a 33-repository workspace is which phase
    // dominates, not which repository.
    const phases: Array<[string, number]> = [];
    await startCollection({ onPhase: (name, ms) => phases.push([name, ms]) });
    const names = phases.map(([name]) => name);
    for (const expected of [
      "recover",
      "config",
      "refs",
      "reflogs",
      "index",
      "state",
      "validator",
    ]) {
      // Once per repository, and both repositories are real.
      expect(names.filter((name) => name === expected)).toHaveLength(2);
    }
    expect(phases.every(([, ms]) => Number.isInteger(ms) && ms >= 0)).toBe(
      true,
    );
  });

  it("dispatches ordinary Git by cwd and promotes safe changes in both attached repositories", async () => {
    collection = await startCollection();
    const env = collection.childEnvironment(process.env.PATH);
    expect(collection.macosGitInterposition()).toEqual({
      dispatcher: path.join(root, "private", "tools", "git"),
      gitBinary: expect.stringMatching(/git$/),
    });
    const initialPrimaryHead = await git(primary, ["rev-parse", "HEAD"]);
    const initialSecondaryHead = await git(secondary, ["rev-parse", "HEAD"]);

    await Promise.all([
      writeFile(path.join(primary, "code.txt"), "primary after\n"),
      writeFile(path.join(secondary, "code.txt"), "secondary after\n"),
    ]);
    await git(root, ["-C", primary, "add", "--", "code.txt"], env);
    await git(root, ["-C", primary, "commit", "-m", "primary code"], env);
    await git(secondary, ["add", "--", "code.txt"], env);
    await git(secondary, ["commit", "-m", "secondary code"], env);

    const privatePrimaryHead = await git(primary, ["rev-parse", "HEAD"], env);
    const privateSecondaryHead = await git(
      secondary,
      ["rev-parse", "HEAD"],
      env,
    );
    expect(privatePrimaryHead).not.toBe(initialPrimaryHead);
    expect(privateSecondaryHead).not.toBe(initialSecondaryHead);
    expect(await git(primary, ["rev-parse", "HEAD"])).toBe(initialPrimaryHead);
    expect(await git(secondary, ["rev-parse", "HEAD"])).toBe(
      initialSecondaryHead,
    );

    await expect(collection.synchronize()).resolves.toEqual({
      state: "promoted",
      updatedRefs: 2,
      indexUpdated: true,
    });
    expect(await git(primary, ["rev-parse", "HEAD"])).toBe(privatePrimaryHead);
    expect(await git(secondary, ["rev-parse", "HEAD"])).toBe(
      privateSecondaryHead,
    );
    expect(
      await readFile(path.join(primaryDesign, "document.json"), "utf8"),
    ).toBe('{"safe":true}\n');
    expect(
      await readFile(path.join(secondaryDesign, "document.json"), "utf8"),
    ).toBe('{"safe":true}\n');
    expect(collection.filesystemProjections()).toHaveLength(2);
  });

  it("refuses a protected snapshot from the secondary repository", async () => {
    collection = await startCollection();
    const env = collection.childEnvironment(process.env.PATH);
    const canonicalHead = await git(secondary, ["rev-parse", "HEAD"]);

    await writeFile(
      path.join(secondaryDesign, "document.json"),
      '{"safe":false}\n',
    );
    await git(secondary, ["add", "--", "Zeros Design/document.json"], env);
    await git(secondary, ["commit", "-m", "forged Design change"], env);

    await expect(collection.synchronize()).rejects.toMatchObject({
      code: "design-impact",
    });
    expect(await git(secondary, ["rev-parse", "HEAD"])).toBe(canonicalHead);
    expect(
      await git(secondary, ["show", "HEAD:Zeros Design/document.json"]),
    ).toBe('{"safe":true}');
  });

  it("preserves recovery state from the collection's per-repository nesting", async () => {
    const previousDataDir = process.env.ZEROS_DATA_DIR;
    process.env.ZEROS_DATA_DIR = path.join(root, "engine");
    try {
      const generation = newTerritoryGeneration();
      collection = await startCollection({
        generation,
        shadowRoot: path.join(
          sessionsRoot(),
          "collection-recovery",
          "boundary",
          generation,
          "git",
        ),
      });

      await expect(
        collection.preserveForRecovery(new Error("process teardown failed")),
      ).resolves.toHaveLength(2);
    } finally {
      if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
      else process.env.ZEROS_DATA_DIR = previousDataDir;
    }
  });

  it("leaves a nearer ordinary nested repository on native Git discovery", async () => {
    const nested = path.join(primary, "vendor", "ordinary-repository");
    await mkdir(nested, { recursive: true });
    await git(nested, ["init", "-b", "main"]);
    collection = await startCollection();
    const env = collection.childEnvironment(process.env.PATH);

    expect(
      await git(root, ["-C", nested, "rev-parse", "--show-toplevel"], env),
    ).toBe(nested);
    expect(
      await git(
        primary,
        [
          `--git-dir=${path.join(secondary, ".git")}`,
          `--work-tree=${secondary}`,
          "rev-parse",
          "--show-toplevel",
        ],
        env,
      ),
    ).toBe(secondary);
  });

  it("keeps two pre-existing linked worktrees on their own private Git views", async () => {
    await rm(secondary, { recursive: true, force: true });
    await git(primary, ["worktree", "add", "-b", "secondary", secondary]);
    secondaryDesign = path.join(secondary, "Zeros Design");
    collection = await startCollection();
    const env = collection.childEnvironment(process.env.PATH);
    const primaryHead = await git(primary, ["rev-parse", "HEAD"]);
    const secondaryHead = await git(secondary, ["rev-parse", "HEAD"]);

    await Promise.all([
      writeFile(path.join(primary, "code.txt"), "primary linked update\n"),
      writeFile(path.join(secondary, "code.txt"), "secondary linked update\n"),
    ]);
    await git(primary, ["add", "--", "code.txt"], env);
    await git(primary, ["commit", "-m", "primary linked code"], env);
    await git(secondary, ["add", "--", "code.txt"], env);
    await git(secondary, ["commit", "-m", "secondary linked code"], env);

    await expect(collection.synchronize()).resolves.toMatchObject({
      state: "promoted",
      updatedRefs: 2,
    });
    expect(await git(primary, ["rev-parse", "HEAD"])).not.toBe(primaryHead);
    expect(await git(secondary, ["rev-parse", "HEAD"])).not.toBe(secondaryHead);
  });
  it("installs the compiled dispatcher and renders a config it can read", async () => {
    // The dispatcher exists to remove a runtime start from every in-fence Git
    // command: measured in a live boundary, an interposed `git --version` is
    // 835-947ms cold and 107-152ms warm through the shell-and-runtime chain,
    // against 5-31ms with the redirect bypassed. This asserts the two halves the
    // engine owns — the binary really replaces `<toolsRoot>/git`, and the
    // configuration is exactly the line-based form the C parser accepts.
    const stub = path.join(root, "zsr-git-dispatch-stub");
    await writeFile(stub, "#!/bin/sh\nexit 0\n", { mode: 0o555 });
    collection = await startCollection({ gitDispatchBinary: stub });

    const tools = path.join(root, "private", "tools");
    const installed = path.join(tools, "git");
    expect(await readFile(installed, "utf8")).toBe("#!/bin/sh\nexit 0\n");
    const configPath = path.join(tools, "git-dispatch.conf");
    expect((await lstat(configPath)).mode & 0o777).toBe(0o400);

    const config = await readFile(configPath, "utf8");
    const lines = config.split("\n").filter((line) => line.length > 0);
    expect(lines[0]).toBe("v1");
    expect(lines).toContain(`runtime ${process.execPath}`);
    expect(lines).toContain(
      `dispatcher ${path.join(tools, "git-dispatcher.mjs")}`,
    );
    // Two repositories here, so the C dispatcher must find two `entry` lines and
    // refuse the fast path rather than pick one of them.
    expect(lines.filter((line) => line === "entry")).toHaveLength(2);
    expect(lines).toContain(`workspaceRoot ${primary}`);
    expect(lines).toContain(`workspaceRoot ${secondary}`);
    // Every key is one token and every value is the rest of the line, which is
    // the entire grammar the parser implements.
    for (const line of lines.slice(1)) {
      expect(line).toMatch(
        /^(runtime|dispatcher|entry|workspaceRoot|gitEntry|shadowRoot|toolsRoot|client|git|env)( |$)/,
      );
    }

    // And the child is told where to find it, so PATH-based and interposed Git
    // both reach the same configuration.
    const env = collection.childEnvironment(process.env.PATH);
    if (process.platform === "darwin") {
      expect(env.ZEROS_ZSR_GIT_DISPATCH_CONFIG).toBe(configPath);
    }
  });

  it("keeps the runtime dispatcher when no compiled one is supplied", async () => {
    collection = await startCollection();
    const installed = path.join(root, "private", "tools", "git");
    expect(await readFile(installed, "utf8")).toContain("git-dispatcher.mjs");
    await expect(
      lstat(path.join(root, "private", "tools", "git-dispatch.conf")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const env = collection.childEnvironment(process.env.PATH);
    expect(env.ZEROS_ZSR_GIT_DISPATCH_CONFIG).toBeUndefined();
  });

  it("points each private client at its own repository's shadow root", async () => {
    // `git-client.mjs` drops the process-wide GIT_DIR/GIT_INDEX_FILE overrides
    // when the caller is inside a linked worktree of the private repository, and
    // it decides that by resolving `<cwd>/.git` and requiring the target to lie
    // inside `config.shadowRoot`. Those overrides are only set on darwin
    // (`childEnvironment` spreads the session env there and nowhere else), so a
    // wrong `shadowRoot` is invisible to every test that runs on Linux — while on
    // macOS it means a commit made inside a linked worktree is written against
    // the PRIMARY checkout's index. This asserts the derivation itself, which is
    // the same on every platform.
    collection = await startCollection();
    const repositoryTools = path.join(
      root,
      "private",
      "tools",
      "git-repositories",
    );
    const ids = (await readdir(repositoryTools)).sort();
    expect(ids).toHaveLength(2);
    const roots = new Map<string, string>();
    for (const id of ids) {
      const client = await readFile(
        path.join(repositoryTools, id, "git-client.mjs"),
        "utf8",
      );
      const embedded = /const config = (\{.*\});/.exec(client);
      expect(embedded).not.toBeNull();
      const config = JSON.parse(embedded![1]!) as { shadowRoot: string };
      expect(config.shadowRoot).toBe(
        path.join(root, "private", "git", id, "git"),
      );
      roots.set(id, config.shadowRoot);
    }

    // And the derivation is right for the reason that matters: a worktree the
    // session creates has to land INSIDE the root the client compares against,
    // or the branch can never fire however well-formed the path looks.
    const env = collection.childEnvironment(process.env.PATH);
    const linked = path.join(root, "linked");
    await git(primary, ["worktree", "add", "-b", "linked", linked], env);
    const pointer = await readFile(path.join(linked, ".git"), "utf8");
    const gitDir = await realpath(
      path.resolve(linked, /^gitdir: (.+)$/m.exec(pointer)![1]!.trim()),
    );
    const inside = await Promise.all(
      [...roots.values()].map(async (shadowRoot) => {
        const relative = path.relative(await realpath(shadowRoot), gitDir);
        return (
          relative !== "" &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative)
        );
      }),
    );
    expect(inside).toContain(true);
  });
});
