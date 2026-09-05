import { execFile } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  AgentGateway,
  agentTerritoryIdentity,
  previewCodeAgentTerritory,
  registeredCodeTerritorySnapshot,
  resolveCodeAgentTerritory,
} from "../gateway";
import type { AgentAdapter, AgentFilesystemTerritory } from "../types";
import type { BoundaryRequest, ExecutionBoundary } from "../containment/types";
import * as projectState from "../../db/projects";
import * as gitState from "../../git/state";
import { firstUseDesignDirectoryNameForRepo } from "../../design/directory";
import { stickyRecognizedDesignDirectories } from "../../design/recognition-store";
import { testExecutionBoundary } from "./helpers/test-execution-boundary";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

function gateway(
  executionBoundary: ExecutionBoundary = testExecutionBoundary(),
): AgentGateway {
  return new AgentGateway({
    projectRoot: "/tmp/zeros-territory-test",
    executionBoundary,
    events: {
      onSessionUpdate: () => {},
      onPermissionRequest: () => {},
      onQuestionRequest: () => {},
      onAgentStderr: () => {},
      onAgentExit: () => {},
    },
  });
}

type TerritoryAdmission = {
  prepareCodeAgentTerritory(
    adapter: AgentAdapter,
    cwd: string,
    workspaceRoot: string | undefined,
    mainRepoRoot: string | undefined,
    stage: "newSession" | "loadSession",
    opts?: { cliBinary?: string },
  ): Promise<AgentFilesystemTerritory | undefined>;
};

type ProviderEnvAdmission = {
  sanitizeProviderEnv(
    env: Record<string, string> | undefined,
  ): Record<string, string> | undefined;
};

type NativeContextSetAdmission = TerritoryAdmission & {
  resolveTerritorySet(
    primary: AgentFilesystemTerritory | undefined,
    cwd: string,
    workspaceRoot: string | undefined,
    env: Record<string, string> | undefined,
    stage: "newSession" | "loadSession" | "forkSession",
  ): Promise<{
    territory?: AgentFilesystemTerritory;
    contextTerritories: readonly AgentFilesystemTerritory[];
  }>;
};

async function fixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-territory-resolution-")),
  );
  roots.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: root,
  });
  await Promise.all([
    mkdir(path.join(root, "src", "nested"), { recursive: true }),
    mkdir(path.join(root, "Zeros Design", "drafts", "nested"), {
      recursive: true,
    }),
    mkdir(path.join(root, "Product Design"), { recursive: true }),
    mkdir(path.join(root, ".zeros"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "src", "nested", "code.ts"), "export {};\n"),
    writeFile(path.join(root, "Zeros Design", ".zeros-canvas.json"), "{}\n"),
    writeFile(path.join(root, "Zeros Design", "frame.html"), "design\n"),
    writeFile(
      path.join(root, "Zeros Design", "drafts", "nested", "ignored.html"),
      "draft\n",
    ),
    writeFile(path.join(root, "Product Design", ".zeros-canvas.json"), "{}\n"),
    writeFile(path.join(root, "Product Design", "frame.html"), "design\n"),
    writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "Product Design"\n',
    ),
    writeFile(path.join(root, ".gitignore"), "Zeros Design/drafts/\n"),
  ]);
  await execFileAsync(
    "git",
    [
      "add",
      "src",
      "Zeros Design/.zeros-canvas.json",
      "Zeros Design/frame.html",
      "Product Design",
      ".zeros/settings.toml",
      ".gitignore",
    ],
    { cwd: root },
  );
  await execFileAsync("git", ["commit", "-q", "-m", "fixture"], {
    cwd: root,
  });
  return root;
}

async function singleDesignFixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-territory-single-")),
  );
  roots.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: root,
  });
  await Promise.all([
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "Zeros Design"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "src", "code.ts"), "export {};\n"),
    writeFile(path.join(root, "Zeros Design", ".zeros-canvas.json"), "{}\n"),
    writeFile(path.join(root, "Zeros Design", "frame.html"), "design\n"),
  ]);
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "fixture"], {
    cwd: root,
  });
  return root;
}

async function prospectiveDesignFixture(): Promise<string> {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-territory-prospective-")),
  );
  roots.push(root);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "test@test"], {
    cwd: root,
  });
  await execFileAsync("git", ["config", "user.name", "test"], {
    cwd: root,
  });
  await Promise.all([
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, ".zeros"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "src", "code.ts"), "export {};\n"),
    writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "Future Design"\n',
    ),
  ]);
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync("git", ["commit", "-q", "-m", "fixture"], {
    cwd: root,
  });
  return root;
}

// resolveCodeAgentTerritory persists sticky Design recognition into the engine
// data dir. Redirect it per file so admissions in this suite never touch the
// developer's real Zeros state, and so each run starts with an empty memory.
let previousDataDir: string | undefined;
let engineDataRoot: string;

async function makeTreeOwnerWritableForCleanup(
  candidate: string,
): Promise<void> {
  const stat = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat || stat.isSymbolicLink()) return;
  if (!stat.isDirectory()) {
    if (stat.isFile()) await chmod(candidate, 0o600);
    return;
  }
  await chmod(candidate, 0o700);
  const entries = await readdir(candidate, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) =>
      makeTreeOwnerWritableForCleanup(path.join(candidate, entry.name)),
    ),
  );
}

beforeAll(async () => {
  previousDataDir = process.env.ZEROS_DATA_DIR;
  engineDataRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "zeros-territory-engine-")),
  );
  process.env.ZEROS_DATA_DIR = engineDataRoot;
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env.ZEROS_DATA_DIR;
  else process.env.ZEROS_DATA_DIR = previousDataDir;
  await makeTreeOwnerWritableForCleanup(engineDataRoot);
  await rm(engineDataRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("code-agent territory resolution", () => {
  it("uses the live Design tree without an alternate checkout or context export", async () => {
    const root = await singleDesignFixture();
    const design = path.join(root, "Zeros Design");
    const territory = await resolveCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });

    expect(territory?.protectedDesignDirectories).toEqual([design]);
    expect(existsSync(path.join(design, "frame.html"))).toBe(true);
    await expect(
      readFile(path.join(design, "frame.html"), "utf8"),
    ).resolves.toBe("design\n");

    const env = { PATH: process.env.PATH ?? "" };
    await expect(
      (gateway() as unknown as ProviderEnvAdmission).sanitizeProviderEnv(env),
    ).toEqual(env);
  });

  it("persists recognition observed by unrestricted native Code admission", async () => {
    const root = await singleDesignFixture();
    const gw = gateway({ ...testExecutionBoundary(), backend: "none" });

    await (gw as unknown as TerritoryAdmission).prepareCodeAgentTerritory(
      { agentId: "codex" } as AgentAdapter,
      path.join(root, "src"),
      root,
      root,
      "newSession",
    );

    await expect(stickyRecognizedDesignDirectories(root)).resolves.toEqual([
      "Zeros Design",
    ]);
    await gw.dispose();
  });

  it("includes attached workspaces' Design roots in native Code context", async () => {
    const primary = await singleDesignFixture();
    const attached = await singleDesignFixture();
    const gw = gateway({ ...testExecutionBoundary(), backend: "none" });
    const admission = gw as unknown as NativeContextSetAdmission;
    const primaryTerritory = await admission.prepareCodeAgentTerritory(
      { agentId: "codex" } as AgentAdapter,
      primary,
      primary,
      primary,
      "newSession",
    );

    const resolved = await admission.resolveTerritorySet(
      primaryTerritory,
      primary,
      primary,
      { ZEROS_ADDITIONAL_DIRS: JSON.stringify([attached]) },
      "newSession",
    );

    expect(resolved.territory?.protectedDesignDirectories).toEqual(
      [
        path.join(attached, "Zeros Design"),
        path.join(primary, "Zeros Design"),
      ].sort(),
    );
    expect(
      resolved.contextTerritories.map((territory) => territory.workspaceRoot),
    ).toEqual([primary, attached]);
    await gw.dispose();
  });

  it("keeps parent and nested Design roots live without a committed projection", async () => {
    const root = await singleDesignFixture();
    const nested = path.join(root, "Zeros Design", "Embedded Design");
    await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, ".zeros-canvas.json"), "{}\n");
    await writeFile(path.join(nested, "nested.html"), "nested design\n");
    await execFileAsync("git", ["add", "Zeros Design/Embedded Design"], {
      cwd: root,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "nested design"], {
      cwd: root,
    });

    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    const parent = path.join(root, "Zeros Design");

    expect(territory?.protectedDesignDirectories).toEqual([parent, nested]);
    const providerEnv = await (
      gateway() as unknown as ProviderEnvAdmission
    ).sanitizeProviderEnv({ PATH: process.env.PATH ?? "" });
    expect(providerEnv).toEqual({ PATH: process.env.PATH ?? "" });
  });

  it("names the recognition inputs separately from Design content", async () => {
    const root = await singleDesignFixture();
    const design = path.join(root, "Zeros Design");
    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });

    // The pointer's settings directory and the folder's own marker — what decides
    // whether this folder is still Design on the NEXT admission. They remain
    // explicit semantic inputs even though host parity leaves committed settings
    // writable; sticky recognition covers de-registration (see policy.ts).
    expect(territory!.designRecognitionPaths).toEqual([
      path.join(root, ".zeros"),
      path.join(design, ".zeros-canvas.json"),
    ]);
    for (const entry of territory!.designRecognitionPaths) {
      expect(territory!.writeCapabilities.deniedPaths).not.toContain(entry);
    }
  });

  it("keeps protecting a Design folder after its Git recognition is removed", async () => {
    const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-territory-sticky-")),
    );
    roots.push(root);
    const design = path.join(root, "Product Design");
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@test"], {
      cwd: root,
    });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: root });
    await Promise.all([
      mkdir(path.join(root, "src"), { recursive: true }),
      mkdir(design, { recursive: true }),
      mkdir(path.join(root, ".zeros"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "src", "code.ts"), "export {};\n"),
      writeFile(path.join(design, ".zeros-canvas.json"), "{}\n"),
      writeFile(path.join(design, "frame.html"), "design\n"),
      writeFile(
        path.join(root, ".zeros", "settings.toml"),
        '[design]\ndirectory = "Product Design"\n',
      ),
    ]);
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "fixture"], {
      cwd: root,
    });

    // One real admission: this is what teaches the engine that "Product Design"
    // is a Design document here.
    const admitted = await resolveCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    expect(admitted?.protectedDesignDirectories).toEqual([design]);

    // Now do exactly what a deliberate agent would: erase both halves of the
    // repository evidence. The marker leaves the index and HEAD, and the pointer
    // leaves settings. Nothing about the Design CONTENT changes — that stayed
    // write-denied throughout — so the folder is still on disk.
    await execFileAsync(
      "git",
      ["rm", "-q", "--cached", "--", "Product Design/.zeros-canvas.json"],
      { cwd: root },
    );
    await writeFile(path.join(root, ".zeros", "settings.toml"), "");
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "de-register"], {
      cwd: root,
    });
    expect(
      existsSync(path.join(design, ".zeros-canvas.json")),
      "the marker file itself is untouched on disk",
    ).toBe(true);

    const afterDeregistration = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    expect(afterDeregistration?.protectedDesignDirectories).toEqual([design]);
    expect(afterDeregistration?.designDirectory).toBe(design);
    expect(afterDeregistration!.writeCapabilities.deniedPaths).toContain(
      design,
    );
  });

  it("forgets a remembered Design folder the user actually deleted", async () => {
    const root = await singleDesignFixture();
    const design = path.join(root, "Zeros Design");
    const nextDesign = path.join(
      root,
      firstUseDesignDirectoryNameForRepo(root),
    );
    expect(
      (
        await resolveCodeAgentTerritory({
          cwd: path.join(root, "src"),
          workspaceRoot: root,
          repoRoot: root,
        })
      )?.protectedDesignDirectories,
    ).toEqual([design]);

    // A user removing their Design folder for real. Sticky recognition must not
    // turn that into "the recognized Design folder is missing from this
    // checkout" on every future session — remembering may only ever protect
    // content that still exists.
    await rm(design, { recursive: true, force: true });
    await execFileAsync("git", ["add", "-A"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "remove design"], {
      cwd: root,
    });

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).resolves.toMatchObject({
      designDirectory: nextDesign,
      protectedDesignDirectories: [nextDesign],
    });
    expect(existsSync(design)).toBe(false);
    expect(existsSync(nextDesign)).toBe(false);
  });

  it("protects an explicitly configured Design destination before it exists", async () => {
    const root = await prospectiveDesignFixture();
    const designRoot = path.join(root, "Future Design");
    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });

    expect(territory).toMatchObject({
      workspaceRoot: root,
      designDirectory: designRoot,
      protectedDesignDirectories: [designRoot],
    });
    expect(territory!.writeCapabilities.deniedPaths).toContain(designRoot);
    expect(existsSync(designRoot)).toBe(false);

    const admitted = await resolveCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    expect(admitted?.designDirectory).toBe(designRoot);
    expect(existsSync(designRoot)).toBe(true);
    expect(await readdir(designRoot)).toEqual([]);

    // The empty reservation remains valid across retries/restarts, but Design
    // initialization has not happened and preflight never seeded document
    // content into the protected tree.
    expect(
      await previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).toMatchObject({ designDirectory: designRoot });
    expect(await readdir(designRoot)).toEqual([]);
  });

  it("does not require a context export for an empty protected destination", async () => {
    const root = await prospectiveDesignFixture();
    const designRoot = path.join(root, "Future Design");
    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    const env = { PATH: process.env.PATH ?? "" };

    expect(territory).toMatchObject({ designDirectory: designRoot });
    await expect(
      (gateway() as unknown as ProviderEnvAdmission).sanitizeProviderEnv(env),
    ).toEqual(env);
    expect(existsSync(designRoot)).toBe(false);
  });

  it("reserves the default Design directory before a managed Code session starts", async () => {
    const root = await prospectiveDesignFixture();
    await writeFile(path.join(root, ".zeros", "settings.toml"), "");
    const defaultDesignRoot = path.join(
      root,
      firstUseDesignDirectoryNameForRepo(root),
    );

    const territory = await resolveCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });
    expect(territory).toMatchObject({
      designDirectory: defaultDesignRoot,
      protectedDesignDirectories: [defaultDesignRoot],
    });
    expect(existsSync(defaultDesignRoot)).toBe(true);
    expect(await readdir(defaultDesignRoot)).toEqual([]);
  });

  it("refuses unsafe or aliased parents for a prospective Design destination", async () => {
    const root = await prospectiveDesignFixture();
    const outside = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-prospective-outside-")),
    );
    roots.push(outside);
    await writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "Future/Design"\n',
    );
    await symlink(outside, path.join(root, "Future"), "dir");

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/prospective Design path.*symlink-free/i);

    await rm(path.join(root, "Future"));
    await writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "../outside"\n',
    );
    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/not a safe repo-relative path/i);
  });

  it("refuses a Unicode-normalized alias for a prospective Design destination", async () => {
    const root = await prospectiveDesignFixture();
    const configured = "Cafe\u0301 Design";
    const onDisk = "Caf\u00e9 Design";
    await writeFile(
      path.join(root, ".zeros", "settings.toml"),
      `[design]\ndirectory = "${configured}"\n`,
    );
    await mkdir(path.join(root, onDisk));

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/exact on-disk spelling/i);
  });

  it("fails closed when a tracked Design root disappears before Git records its removal", async () => {
    const root = await singleDesignFixture();
    await rm(path.join(root, "Zeros Design"), { recursive: true });

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/recognized Design folder.*missing/i);
  });

  it("fails closed across both sides of a staged Design rename", async () => {
    const root = await singleDesignFixture();
    await rename(
      path.join(root, "Zeros Design"),
      path.join(root, "Renamed Design"),
    );
    await execFileAsync("git", ["add", "-A"], { cwd: root });

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/design folders were found/i);
  });

  it("anchors a nested cwd to one canonical workspace and protects every recognized Design tree", async () => {
    const root = await fixture();
    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src", "nested"),
      workspaceRoot: root,
      repoRoot: root,
    });

    expect(territory).toMatchObject({
      agentRole: "code",
      workspaceRoot: root,
      designDirectory: path.join(root, "Product Design"),
      protectedDesignDirectories: [
        path.join(root, "Product Design"),
        path.join(root, "Zeros Design"),
      ],
      writeCapabilities: { workspace: "write" },
    });
    expect(territory!.writeCapabilities.deniedPaths).toEqual(
      expect.arrayContaining([
        path.join(root, "Product Design"),
        path.join(root, "Zeros Design"),
      ]),
    );
    // The ignored nested draft is intentionally absent from the policy list:
    // protecting its parent subtree covers existing and future children.
    expect(territory!.writeCapabilities.deniedPaths).not.toContain(
      path.join(root, "Zeros Design", "drafts", "nested", "ignored.html"),
    );
  });

  it("rejects an agent cwd outside the declared canonical workspace", async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), "zeros-outside-cwd-"));
    roots.push(outside);
    await expect(
      previewCodeAgentTerritory({ cwd: outside, workspaceRoot: root }),
    ).rejects.toThrow(/outside its canonical workspace/i);
  });

  it("refuses symlink aliases for a Design-bearing workspace or cwd", async () => {
    const root = await fixture();
    const aliasParent = await mkdtemp(
      path.join(tmpdir(), "zeros-territory-alias-"),
    );
    roots.push(aliasParent);
    const workspaceAlias = path.join(aliasParent, "workspace");
    await symlink(root, workspaceAlias, "dir");

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(workspaceAlias, "src"),
        workspaceRoot: workspaceAlias,
        repoRoot: workspaceAlias,
      }),
    ).rejects.toThrow(/canonical physical workspace and cwd paths/i);

    const cwdAlias = path.join(root, "source-alias");
    await symlink(path.join(root, "src"), cwdAlias, "dir");
    await expect(
      previewCodeAgentTerritory({
        cwd: cwdAlias,
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/canonical physical workspace and cwd paths/i);
  });

  it("does not impose physical-path qualification on an ordinary code-only workspace", async () => {
    const physical = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-code-only-")),
    );
    roots.push(physical);
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: physical,
    });
    const aliasParent = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-code-only-alias-")),
    );
    roots.push(aliasParent);
    const alias = path.join(aliasParent, "workspace");
    await symlink(physical, alias, "dir");

    await expect(
      previewCodeAgentTerritory({ cwd: alias, workspaceRoot: alias }),
    ).resolves.toBeUndefined();
  });

  it("accepts a code-only Git cwd alias when Git reports its physical owner", async () => {
    const physical = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-code-only-git-")),
    );
    roots.push(physical);
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: physical,
    });
    const aliasParent = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-code-only-git-alias-")),
    );
    roots.push(aliasParent);
    const alias = path.join(aliasParent, "workspace");
    await symlink(physical, alias, "dir");

    await expect(
      previewCodeAgentTerritory({ cwd: alias }),
    ).resolves.toBeUndefined();
  });

  it("fails closed when a declared workspace hides a nested Git owner with Design authority", async () => {
    const outer = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-nested-owner-")),
    );
    roots.push(outer);
    await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: outer });
    const nested = path.join(outer, "packages", "nested");
    await Promise.all([
      mkdir(path.join(nested, "src"), { recursive: true }),
      mkdir(path.join(nested, "Zeros Design"), { recursive: true }),
    ]);
    await execFileAsync("git", ["init", "-q", "-b", "main"], {
      cwd: nested,
    });
    await Promise.all([
      writeFile(path.join(nested, "src", "code.ts"), "export {};\n"),
      writeFile(
        path.join(nested, "Zeros Design", ".zeros-canvas.json"),
        "{}\n",
      ),
    ]);
    await execFileAsync("git", ["add", "-A"], { cwd: nested });

    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(nested, "src"),
        workspaceRoot: outer,
        repoRoot: outer,
      }),
    ).rejects.toThrow(/nested Git owner/i);
  });

  it("keeps linked-worktree and common Git metadata writable", async () => {
    const main = await singleDesignFixture();
    const worktreeParent = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-linked-worktree-")),
    );
    roots.push(worktreeParent);
    const worktree = path.join(worktreeParent, "feature");
    await execFileAsync(
      "git",
      ["worktree", "add", "-q", "-b", "feature", worktree],
      { cwd: main },
    );
    const canonicalWorktree = await realpath(worktree);
    const [{ stdout: gitDirRaw }, { stdout: commonDirRaw }] = await Promise.all(
      [
        execFileAsync("git", ["rev-parse", "--absolute-git-dir"], {
          cwd: canonicalWorktree,
        }),
        execFileAsync("git", ["rev-parse", "--git-common-dir"], {
          cwd: canonicalWorktree,
        }),
      ],
    );
    const gitDir = path.resolve(gitDirRaw.trim());
    const commonDir = path.resolve(
      path.isAbsolute(commonDirRaw.trim())
        ? commonDirRaw.trim()
        : path.join(canonicalWorktree, commonDirRaw.trim()),
    );

    const territory = await previewCodeAgentTerritory({
      cwd: canonicalWorktree,
      workspaceRoot: canonicalWorktree,
      repoRoot: main,
    });

    expect(territory!.writeCapabilities.deniedPaths).not.toEqual(
      expect.arrayContaining([
        path.join(canonicalWorktree, ".git"),
        gitDir,
        commonDir,
      ]),
    );
    expect(territory!.writeCapabilities.deniedPaths).toEqual([
      path.join(canonicalWorktree, "Zeros Design"),
    ]);
  });

  it("fails admission when any Design inode has a writable alias outside the protected subtree", async () => {
    const root = await fixture();
    await link(
      path.join(root, "Zeros Design", "frame.html"),
      path.join(root, "src", "design-alias.html"),
    );
    await expect(
      previewCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).rejects.toThrow(/hard-linked file/i);
  });

  it("uses semantic identity rather than array ordering for resumed-session invalidation", async () => {
    const root = await fixture();
    const territory = (await previewCodeAgentTerritory({
      cwd: root,
      workspaceRoot: root,
      repoRoot: root,
    }))!;
    const reordered = {
      ...territory,
      protectedDesignDirectories: [
        ...territory.protectedDesignDirectories,
      ].reverse(),
      writeCapabilities: {
        ...territory.writeCapabilities,
        deniedPaths: [...territory.writeCapabilities.deniedPaths].reverse(),
      },
    };
    expect(agentTerritoryIdentity(reordered)).toBe(
      agentTerritoryIdentity(territory),
    );
    expect(
      agentTerritoryIdentity({
        ...territory,
        designDirectory: path.join(root, "Zeros Design"),
      }),
    ).not.toBe(agentTerritoryIdentity(territory));
  });

  it("keeps Code authority stable across both Code and Design commits", async () => {
    const root = await singleDesignFixture();
    const resolve = () =>
      previewCodeAgentTerritory({
        cwd: root,
        workspaceRoot: root,
        repoRoot: root,
      });
    const initial = (await resolve())!;

    await writeFile(path.join(root, "src", "code.ts"), "export const n = 1;\n");
    await execFileAsync("git", ["add", "src/code.ts"], { cwd: root });
    await execFileAsync("git", ["commit", "-q", "-m", "code only"], {
      cwd: root,
    });
    const afterCode = (await resolve())!;
    expect(agentTerritoryIdentity(afterCode)).toBe(
      agentTerritoryIdentity(initial),
    );

    await writeFile(
      path.join(root, "Zeros Design", "frame.html"),
      "updated design\n",
    );
    await execFileAsync("git", ["add", "Zeros Design/frame.html"], {
      cwd: root,
    });
    await execFileAsync("git", ["commit", "-q", "-m", "design update"], {
      cwd: root,
    });
    const afterDesign = (await resolve())!;
    expect(agentTerritoryIdentity(afterDesign)).toBe(
      agentTerritoryIdentity(afterCode),
    );
  });

  it("recognizes Design territory without requiring a provider-specific Code sandbox", async () => {
    const root = await fixture();
    const admission = gateway() as unknown as TerritoryAdmission;
    const unsupported = {
      agentId: "unsupported",
    } as AgentAdapter;

    await expect(
      admission.prepareCodeAgentTerritory(
        unsupported,
        path.join(root, "src"),
        root,
        root,
        "newSession",
      ),
    ).resolves.toMatchObject({
      workspaceRoot: root,
      designDirectory: path.join(root, "Product Design"),
    });
  });

  it("keeps local Code native when Design identity is damaged or reached through an alias", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "../unsafe"\n',
    );
    const alias = `${root}-alias`;
    roots.push(alias);
    await symlink(root, alias, "dir");

    const workspace = {
      id: "ws_native_code",
      path: alias,
      repoRoot: alias,
      placement: "local",
    } as ReturnType<typeof gitState.listWorkspaces>[number];
    const workspaceByIdSpy = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(workspace);
    const requests: BoundaryRequest[] = [];
    const secureTestBoundary = testExecutionBoundary({
      onPrepare: (request) => requests.push(request),
    });
    const localBoundary: ExecutionBoundary = {
      ...secureTestBoundary,
      backend: "none",
    };
    const diagnostics: string[] = [];
    const gw = new AgentGateway({
      projectRoot: root,
      executionBoundary: localBoundary,
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: (_agentId, line) => diagnostics.push(line),
        onAgentExit: () => {},
      },
    });
    const newSession = vi.fn(
      async (opts: { executionId?: string; systemInstruction?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      }),
    );
    const adapter = {
      agentId: "native-code",
      nativeSystemInstruction: true,
      newSession,
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "native-code",
      adapter,
    );

    try {
      const session = await gw.newSession("native-code", {
        cwd: alias,
        workspaceId: workspace.id,
      });

      expect(newSession).toHaveBeenCalledOnce();
      expect(diagnostics.join("\n")).toContain(
        "configured Design directory is invalid",
      );
      const instruction = newSession.mock.calls[0]![0]
        .systemInstruction as string;
      expect(instruction).toContain(path.join(alias, "Product Design"));
      expect(instruction).toContain(path.join(alias, "Zeros Design"));
      const request = requests.find(
        (candidate) => candidate.executionId === session.executionId,
      );
      expect(request).toMatchObject({
        actor: "agent-code",
        cwd: alias,
        workspaceRoot: alias,
        backendHint: "none",
      });
      expect(request).not.toHaveProperty("protectedWorkspaceDirectories");
      expect(request).not.toHaveProperty("protectedCodeDirectories");
      expect(request).not.toHaveProperty("gitIntegrationRoots");
    } finally {
      await gw.dispose();
      workspaceByIdSpy.mockRestore();
    }
  });

  it("fails a local Design-agent admission closed for the same damaged identity", async () => {
    const root = await fixture();
    await writeFile(
      path.join(root, ".zeros", "settings.toml"),
      '[design]\ndirectory = "../unsafe"\n',
    );
    const workspace = {
      id: "ws_contained_design",
      path: root,
      repoRoot: root,
      placement: "local",
    } as ReturnType<typeof gitState.listWorkspaces>[number];
    const workspaceByIdSpy = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockReturnValue(workspace);
    const gw = new AgentGateway({
      projectRoot: root,
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const adapter = {
      agentId: "contained-design",
      newSession: vi.fn(),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained-design",
      adapter,
    );

    try {
      await expect(
        gw.newDesignSession(
          "contained-design",
          {
            actor: "design-agent",
            agentRunId: "run-damaged-design",
            env: {
              ZEROS_DESIGN_AGENT_CAPABILITY: `Bearer ${"a".repeat(64)}`,
            },
            mcpServers: [
              {
                name: "design-draft",
                transport: "http",
                url: "http://127.0.0.1:43123/mcp",
                headersFromEnv: {
                  Authorization: "ZEROS_DESIGN_AGENT_CAPABILITY",
                },
              },
            ],
            trustedLocalPorts: [43123],
          },
          { cwd: root, workspaceId: workspace.id },
        ),
      ).rejects.toMatchObject({
        failure: {
          kind: "protocol-error",
          stage: "newSession",
          message: expect.stringContaining("Design agent cannot start"),
        },
      });
      expect(adapter.newSession).not.toHaveBeenCalled();
    } finally {
      await gw.dispose();
      workspaceByIdSpy.mockRestore();
    }
  });

  it("prepares the exact uniform territory and propagates a ZSR refusal", async () => {
    const root = await fixture();
    const onPrepare = vi.fn();
    const gw = gateway(
      testExecutionBoundary({
        onPrepare,
        prepareError: new Error("uniform sandbox unavailable"),
      }),
    );
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    const refusal = (await gw
      .newSession("contained", { cwd: path.join(root, "src") })
      .catch((error: unknown) => error)) as {
      failure: { message: string; advice?: string };
    };
    expect(refusal).toMatchObject({
      failure: {
        kind: "design-protection-failed",
        stage: "prompt",
        agentId: "contained",
      },
    });
    expect(refusal.failure).not.toHaveProperty("advice");
    expect(refusal.failure.message).not.toMatch(/sandbox|ZSR/i);
    expect(onPrepare).toHaveBeenCalledOnce();
    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent-code",
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        territory: expect.objectContaining({
          designDirectory: path.join(root, "Product Design"),
          protectedDesignDirectories: [
            path.join(root, "Product Design"),
            path.join(root, "Zeros Design"),
          ],
        }),
      }),
      { attestation: "background" },
    );
    expect(adapter.newSession).not.toHaveBeenCalled();
  });

  it("retires a prepared boundary when the primary Design pointer changes during admission", async () => {
    const root = await fixture();
    const onStop = vi.fn();
    let changed = false;
    const gw = gateway(
      testExecutionBoundary({
        onPrepare: () => {
          if (changed) return;
          changed = true;
          writeFileSync(
            path.join(root, ".zeros", "settings.toml"),
            '[design]\ndirectory = "Zeros Design"\n',
          );
        },
        onStop,
      }),
    );
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    try {
      const session = await gw.newSession("contained", {
        cwd: path.join(root, "src"),
      });
      expect(adapter.newSession).toHaveBeenCalledOnce();
      await vi.waitFor(() => expect(onStop).toHaveBeenCalled());
      await expect(
        gw.prompt("contained", session.executionId, [
          { type: "text", text: "must not run" },
        ] as never),
      ).rejects.toMatchObject({
        failure: {
          kind: "design-protection-failed",
          stage: "prompt",
        },
      });
    } finally {
      await gw.dispose();
    }
  });

  it("subtracts Design authority from an attached workspace and tracks its lifecycle owner", async () => {
    const primary = await prospectiveDesignFixture();
    await writeFile(path.join(primary, ".zeros", "settings.toml"), "");
    const attached = await singleDesignFixture();
    const onPrepare = vi.fn();
    let adapterTerritory: AgentFilesystemTerritory | undefined;
    let adapterEnv: Record<string, string> | undefined;
    const gw = gateway(testExecutionBoundary({ onPrepare }));
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(
        async (opts: {
          executionId?: string;
          territory?: AgentFilesystemTerritory;
          env?: Record<string, string>;
        }) => {
          adapterTerritory = opts.territory;
          adapterEnv = opts.env;
          return {
            session: {
              executionId: opts.executionId!,
              sessionId: opts.executionId!,
            },
            initialize: {},
          };
        },
      ),
      disposeSession: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    const session = await gw.newSession("contained", {
      cwd: primary,
      env: {
        ZEROS_ADDITIONAL_DIRS: JSON.stringify([attached]),
        // Keep this territory test independent from Docker/OrbStack binaries
        // installed on the machine running it. Container parity has dedicated
        // boundary tests; this case exercises attached Design authority only.
        PATH: "",
        DOCKER_HOST: "",
        DOCKER_CONTEXT: "",
        CONTAINER_HOST: "",
        PODMAN_HOST: "",
        CONTAINER_CONNECTION: "",
      },
    });
    const attachedDesign = path.join(attached, "Zeros Design");

    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: primary,
        additionalReadWriteRoots: [attached],
        additionalGitWorkspaceRoots: [attached],
        codeTerritoryOwners: [
          {
            workspaceRoot: attached,
            protectedDesignDirectories: [attachedDesign],
          },
        ],
        territory: expect.objectContaining({
          workspaceRoot: primary,
          protectedDesignDirectories: [attachedDesign],
          writeCapabilities: expect.objectContaining({
            deniedPaths: [attachedDesign],
          }),
        }),
      }),
      { attestation: "background" },
    );
    expect(adapterTerritory?.protectedDesignDirectories).toEqual([
      attachedDesign,
    ]);
    expect(adapterEnv).not.toHaveProperty("ZEROS_ISOLATION_CONTEXT_DIRS");
    expect(existsSync(attachedDesign)).toBe(true);
    expect(session.boundary?.parity).toEqual({
      level: "full",
      restrictions: [],
    });
    expect(gw.workspaceSessionIds("attached-workspace", attached)).toEqual([
      session.executionId,
    ]);
    expect(
      gw.workspaceTerritoryChanged("attached-workspace", attached, undefined),
    ).toBe(true);

    await gw.endSession("contained", session.executionId, {
      failClosed: true,
    });
    expect(gw.workspaceSessionIds("attached-workspace", attached)).toEqual([]);
  });

  it("publishes provisional territory while boundary admission is in flight", async () => {
    const primary = await singleDesignFixture();
    const baseBoundary = testExecutionBoundary();
    let releasePrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    let publishExecutionId!: (executionId: string) => void;
    const executionIdReady = new Promise<string>((resolve) => {
      publishExecutionId = resolve;
    });
    const executionBoundary: ExecutionBoundary = {
      ...baseBoundary,
      prepare: async (request, control) => {
        publishExecutionId(request.executionId);
        await prepareGate;
        return baseBoundary.prepare(request, control);
      },
    };
    const gw = gateway(executionBoundary);
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );
    const admission = gw.newSession("contained", { cwd: primary });

    try {
      const executionId = await executionIdReady;
      expect(gw.workspaceSessionIds("rowless-primary", primary)).toEqual([
        executionId,
      ]);
      expect(
        gw.workspaceTerritoryChanged("rowless-primary", primary, undefined),
      ).toBe(true);
    } finally {
      releasePrepare();
      const session = await admission;
      await gw.endSession("contained", session.executionId, {
        failClosed: true,
      });
      await gw.dispose();
    }
  });

  it("subtracts every registered local Design root without granting its checkout", async () => {
    const primary = await prospectiveDesignFixture();
    await writeFile(path.join(primary, ".zeros", "settings.toml"), "");
    const registeredWorktree = await singleDesignFixture();
    const registeredMain = await singleDesignFixture();
    const registeredProject = await singleDesignFixture();
    const cloudCheckout = await singleDesignFixture();
    const archivedCheckout = await singleDesignFixture();
    const activeRows = [
      {
        id: "ws_registered",
        path: registeredWorktree,
        repoRoot: registeredMain,
        placement: "local",
      },
      {
        id: "ws_cloud",
        path: cloudCheckout,
        repoRoot: cloudCheckout,
        placement: "cloud",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>;
    const archivedRows = [
      ...activeRows,
      {
        id: "ws_archived",
        path: archivedCheckout,
        repoRoot: archivedCheckout,
        placement: "local",
        archivedAt: Date.now(),
      },
    ] as ReturnType<typeof gitState.listWorkspaces>;
    const listSpy = vi
      .spyOn(gitState, "listWorkspaces")
      .mockImplementation((filter) =>
        filter?.archived === false ? activeRows : archivedRows,
      );
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([registeredProject]);
    const onPrepare = vi.fn();
    const gw = gateway(testExecutionBoundary({ onPrepare }));
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(
        async (opts: {
          executionId?: string;
          territory?: AgentFilesystemTerritory;
        }) => ({
          session: {
            executionId: opts.executionId!,
            sessionId: opts.executionId!,
          },
          initialize: {},
        }),
      ),
      disposeSession: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    try {
      const session = await gw.newSession("contained", { cwd: primary });
      const registeredDesignRoots = [
        registeredMain,
        registeredProject,
        registeredWorktree,
      ]
        .map((root) => path.join(root, "Zeros Design"))
        .sort((left, right) => left.localeCompare(right));

      expect(onPrepare).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceRoot: primary,
          territory: expect.objectContaining({
            protectedDesignDirectories: expect.arrayContaining(
              registeredDesignRoots,
            ),
          }),
        }),
        { attestation: "background" },
      );
      expect(
        (
          onPrepare.mock.calls[0]?.[0] as {
            territory?: AgentFilesystemTerritory;
            additionalReadWriteRoots?: string[];
            additionalGitWorkspaceRoots?: string[];
          }
        ).territory?.protectedDesignDirectories,
      ).not.toContain(path.join(cloudCheckout, "Zeros Design"));
      expect(
        (
          onPrepare.mock.calls[0]?.[0] as {
            territory?: AgentFilesystemTerritory;
          }
        ).territory?.protectedDesignDirectories,
      ).not.toContain(path.join(archivedCheckout, "Zeros Design"));
      expect(
        (
          onPrepare.mock.calls[0]?.[0] as {
            territory?: AgentFilesystemTerritory;
          }
        ).territory?.protectedDesignDirectories,
      ).toHaveLength(3);
      const request = onPrepare.mock.calls[0]?.[0] as {
        additionalReadWriteRoots?: string[];
        additionalGitWorkspaceRoots?: string[];
      };
      expect(request.additionalReadWriteRoots ?? []).toEqual([]);
      expect(request.additionalGitWorkspaceRoots ?? []).toEqual([]);
      expect(
        gw.workspaceSessionIds("ws_registered", registeredWorktree),
      ).toEqual([session.executionId]);
      expect(gw.workspaceSessionIds("local-main", registeredMain)).toEqual([
        session.executionId,
      ]);

      await gw.endSession("contained", session.executionId, {
        failClosed: true,
      });
    } finally {
      projectSpy.mockRestore();
      listSpy.mockRestore();
    }
  });

  it("reserves active and explicitly attached managed Code owners", async () => {
    const previousWorkspacesDir = process.env.ZEROS_WORKSPACES_DIR;
    const container = await realpath(
      await mkdtemp(path.join(tmpdir(), "zeros-managed-territory-")),
    );
    roots.push(container);
    const managed = path.join(container, "workspaces");
    process.env.ZEROS_WORKSPACES_DIR = managed;
    const primarySource = await prospectiveDesignFixture();
    const siblingSource = await prospectiveDesignFixture();
    await Promise.all([
      writeFile(path.join(primarySource, ".zeros", "settings.toml"), ""),
      writeFile(path.join(siblingSource, ".zeros", "settings.toml"), ""),
    ]);
    const registeredMain = await singleDesignFixture();
    const primary = path.join(managed, "zeros", "Shocking");
    const sibling = path.join(managed, "zeros", "Onyx");
    const prospectiveDesignName =
      firstUseDesignDirectoryNameForRepo(registeredMain);
    const primaryDesign = path.join(primary, prospectiveDesignName);
    const siblingDesign = path.join(sibling, prospectiveDesignName);
    await Promise.all([
      mkdir(path.dirname(primary), { recursive: true }),
      mkdir(path.dirname(sibling), { recursive: true }),
    ]);
    await rename(primarySource, primary);
    await rename(siblingSource, sibling);
    const managedWorkspaces = [
      {
        id: "ws_shocking",
        path: primary,
        repoRoot: registeredMain,
        placement: "local",
      },
      {
        id: "ws_onyx",
        path: sibling,
        repoRoot: registeredMain,
        placement: "local",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>;
    const workspaceSpy = vi
      .spyOn(gitState, "listWorkspaces")
      .mockReturnValue(managedWorkspaces);
    const workspaceByIdSpy = vi
      .spyOn(gitState, "getWorkspaceById")
      .mockImplementation(
        (workspaceId) =>
          managedWorkspaces.find((workspace) => workspace.id === workspaceId) ??
          null,
      );
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([registeredMain]);
    const requests: BoundaryRequest[] = [];
    const gw = gateway(
      testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
      }),
    );
    const adapter = {
      agentId: "contained",
      listSessions: vi.fn(async () => ({ sessions: [] })),
      newSession: vi.fn(async (opts: { executionId?: string }) => ({
        session: {
          executionId: opts.executionId!,
          sessionId: opts.executionId!,
        },
        initialize: {},
      })),
      disposeSession: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    try {
      await gw.listSessions("contained", { cwd: primary });
      await expect(readdir(primaryDesign)).rejects.toMatchObject({
        code: "ENOENT",
      });
      requests.length = 0;

      const session = await gw.newSession("contained", {
        cwd: primary,
        workspaceId: "ws_shocking",
      });
      const request = requests[0] as BoundaryRequest & {
        protectedWorkspaceDirectories?: readonly string[];
      };

      expect(request.protectedWorkspaceDirectories).toContain(managed);
      expect(request.territory?.protectedDesignDirectories).toContain(
        primaryDesign,
      );
      await expect(readdir(primaryDesign)).resolves.toEqual([]);
      expect(request.territory?.protectedDesignDirectories).toContain(
        path.join(registeredMain, "Zeros Design"),
      );
      expect(request.territory?.protectedDesignDirectories).not.toContain(
        siblingDesign,
      );
      expect(gw.workspaceSessionIds("ws_onyx", sibling)).toEqual([]);

      await gw.endSession("contained", session.executionId, {
        failClosed: true,
      });

      requests.length = 0;
      const attachedSession = await gw.newSession("contained", {
        cwd: primary,
        workspaceId: "ws_shocking",
        env: { ZEROS_ADDITIONAL_DIRS: JSON.stringify([managed]) },
      });
      expect(requests[0]?.protectedWorkspaceWriteDirectories).toEqual(
        expect.arrayContaining([primary, sibling]),
      );
      expect(requests[0]?.territory?.protectedDesignDirectories).toContain(
        siblingDesign,
      );
      await expect(readdir(siblingDesign)).resolves.toEqual([]);
      await gw.endSession("contained", attachedSession.executionId, {
        failClosed: true,
      });
    } finally {
      await gw.dispose();
      projectSpy.mockRestore();
      workspaceByIdSpy.mockRestore();
      workspaceSpy.mockRestore();
      if (previousWorkspacesDir === undefined) {
        delete process.env.ZEROS_WORKSPACES_DIR;
      } else {
        process.env.ZEROS_WORKSPACES_DIR = previousWorkspacesDir;
      }
    }
  });

  it("subtracts every registered Design root from all provider one-shot boundaries", async () => {
    const primary = await prospectiveDesignFixture();
    await writeFile(path.join(primary, ".zeros", "settings.toml"), "");
    const registered = await singleDesignFixture();
    const workspaceSpy = vi
      .spyOn(gitState, "listWorkspaces")
      .mockReturnValue([]);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([registered]);
    const requests: BoundaryRequest[] = [];
    const gw = new AgentGateway({
      projectRoot: primary,
      executionBoundary: testExecutionBoundary({
        onPrepare: (request) => requests.push(request),
      }),
      events: {
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onQuestionRequest: () => {},
        onAgentStderr: () => {},
        onAgentExit: () => {},
      },
    });
    const adapter = {
      agentId: "contained",
      listSessions: vi.fn(async () => ({ sessions: [] })),
      generateText: vi.fn(async () => "A title"),
      dispose: vi.fn(async () => {}),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    try {
      await gw.listSessions("contained", { cwd: primary });
      await gw.generateTitle("contained", {
        model: "test",
        systemPrompt: "title",
        prompt: "conversation",
      });
      await (
        gw as unknown as {
          runProviderProbeCommand(
            providerId: string,
            binary: string,
            args: string[],
            options: { timeoutMs: number },
          ): Promise<{ exitCode: number | null; stdout: string }>;
        }
      ).runProviderProbeCommand(
        "contained",
        process.execPath,
        ["-e", "process.stdout.write('ok\\n')"],
        { timeoutMs: 5_000 },
      );

      // Session discovery and title generation intentionally reuse one
      // policy-identical utility boundary; the CLI probe has its own root.
      expect(requests).toHaveLength(3);
      const registeredDesign = path.join(registered, "Zeros Design");
      for (const request of requests) {
        expect(request.actor).toBe("agent-code");
        expect(request.territory?.protectedDesignDirectories).toContain(
          registeredDesign,
        );
        expect(request.territory?.writeCapabilities.deniedPaths).toContain(
          registeredDesign,
        );
        expect(request.additionalReadWriteRoots ?? []).not.toContain(
          registered,
        );
      }
      const registeredTerritory = await previewCodeAgentTerritory({
        cwd: registered,
        workspaceRoot: registered,
        repoRoot: registered,
      });
      expect(
        gw.pooledUtilityWorkspaceTerritoryChanged(
          registered,
          registeredTerritory,
        ),
      ).toBe(false);
      expect(
        gw.pooledUtilityWorkspaceTerritoryChanged(registered, undefined),
      ).toBe(true);
    } finally {
      await gw.dispose();
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });

  it("subtracts every registered code owner from a design-actor boundary", async () => {
    const primary = await singleDesignFixture();
    const siblingWorktree = await singleDesignFixture();
    const siblingMain = await singleDesignFixture();
    const siblingProject = await singleDesignFixture();
    const workspaceSpy = vi.spyOn(gitState, "listWorkspaces").mockReturnValue([
      {
        id: "ws_design_sibling",
        path: siblingWorktree,
        repoRoot: siblingMain,
        placement: "local",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([siblingProject]);
    const gw = gateway();
    const internal = gw as unknown as {
      boundaryRequest(
        executionId: string,
        cwd: string,
        workspaceRoot: string,
        territory: AgentFilesystemTerritory | undefined,
        env: undefined,
        providerId: undefined,
        mcpServers: readonly never[],
        resolvedAdditionalRoots: readonly string[],
        additionalGitWorkspaceRoots: readonly string[],
        includeSessionCapabilities: boolean,
        actor: "design-agent",
      ): Promise<BoundaryRequest>;
    };

    try {
      const territory = await previewCodeAgentTerritory({
        cwd: primary,
        workspaceRoot: primary,
        repoRoot: primary,
      });
      const request = await internal.boundaryRequest(
        "design-global-code",
        primary,
        primary,
        territory,
        undefined,
        undefined,
        [],
        [],
        [],
        false,
        "design-agent",
      );

      expect(request.protectedCodeDirectories).toEqual(
        expect.arrayContaining([
          primary,
          siblingWorktree,
          siblingMain,
          siblingProject,
        ]),
      );
      expect(request.protectedWorkspaceDirectories).toEqual(
        expect.arrayContaining([
          gitState.worktreesRoot(),
          gitState.designWorktreesRoot(),
          gitState.legacyWorktreesRoot(),
        ]),
      );
      expect(request.territory?.protectedDesignDirectories).toEqual(
        expect.arrayContaining([
          path.join(primary, "Zeros Design"),
          path.join(siblingWorktree, "Zeros Design"),
          path.join(siblingMain, "Zeros Design"),
          path.join(siblingProject, "Zeros Design"),
        ]),
      );
      expect(request.additionalReadWriteRoots ?? []).toEqual([]);
    } finally {
      await gw.dispose();
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });

  it("fails closed when either registered-owner source cannot be read", () => {
    const workspaceSpy = vi.spyOn(gitState, "listWorkspaces");
    const projectSpy = vi.spyOn(projectState, "listKnownRepoRoots");
    try {
      workspaceSpy.mockImplementation(() => {
        throw new Error("workspace registry unavailable");
      });
      projectSpy.mockReturnValue([]);
      expect(() => registeredCodeTerritorySnapshot()).toThrow(
        /workspace registry unavailable/,
      );

      workspaceSpy.mockReturnValue([]);
      projectSpy.mockImplementation(() => {
        throw new Error("project registry unavailable");
      });
      expect(() => registeredCodeTerritorySnapshot()).toThrow(
        /project registry unavailable/,
      );

      projectSpy.mockReturnValue(["invalid\0project-root"]);
      expect(() => registeredCodeTerritorySnapshot()).toThrow();
    } finally {
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });

  it("retains a live main checkout when its registered worktree path is stale", async () => {
    const registeredMain = await singleDesignFixture();
    const workspaceSpy = vi.spyOn(gitState, "listWorkspaces").mockReturnValue([
      {
        id: "ws_missing_worktree",
        path: path.join(registeredMain, "missing-worktree"),
        repoRoot: registeredMain,
        placement: "local",
      },
    ] as ReturnType<typeof gitState.listWorkspaces>);
    const projectSpy = vi
      .spyOn(projectState, "listKnownRepoRoots")
      .mockReturnValue([]);

    try {
      expect(registeredCodeTerritorySnapshot().owners).toContainEqual({
        path: registeredMain,
        repoRoot: registeredMain,
      });
    } finally {
      projectSpy.mockRestore();
      workspaceSpy.mockRestore();
    }
  });
});
