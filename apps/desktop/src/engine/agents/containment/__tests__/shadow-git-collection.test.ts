import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runFile } from "../../../git/git-exec";
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
    root = await mkdtemp(path.join(tmpdir(), "zeros-shadow-git-set-"));
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

  async function startCollection(): Promise<ShadowGitCollection> {
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
      shadowRoot: path.join(root, "private", "git"),
      privateHome: path.join(root, "private", "home"),
      commandsRoot: path.join(root, "private", "commands"),
      toolsRoot: path.join(root, "private", "tools"),
      toolRuntime: process.execPath,
      generation: newTerritoryGeneration(),
      territory,
    });
    collection = active;
    return active;
  }

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
});
