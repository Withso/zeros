import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  link,
  mkdir,
  mkdtemp,
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
  resolveCodeAgentTerritory,
} from "../gateway";
import type { AgentAdapter, AgentFilesystemTerritory } from "../types";
import type { ExecutionBoundary } from "../containment/types";
import { designDirectoryNameFor } from "../../design/directory-registry";
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
  await rm(engineDataRoot, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("code-agent territory resolution", () => {
  it("names the recognition inputs separately from Design content", async () => {
    const root = await singleDesignFixture();
    const design = path.join(root, "Zeros Design");
    const territory = await previewCodeAgentTerritory({
      cwd: path.join(root, "src"),
      workspaceRoot: root,
      repoRoot: root,
    });

    // The pointer's settings directory and the folder's own marker — what decides
    // whether this folder is still Design on the NEXT admission. Named explicitly
    // because the two profiles treat them differently: the isolated profile denies
    // them with the rest of the policy carveouts, while host parity subtracts them
    // (denying `.zeros` broke `git pull`, and sticky recognition covers
    // de-registration instead — see containment/policy.ts).
    expect(territory!.designRecognitionPaths).toEqual([
      path.join(root, ".zeros"),
      path.join(design, ".zeros-canvas.json"),
    ]);
    for (const entry of territory!.designRecognitionPaths) {
      expect(territory!.writeCapabilities.deniedPaths).toContain(entry);
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
    await execFileAsync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });

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
    expect(afterDeregistration!.writeCapabilities.deniedPaths).toContain(design);
  });

  it("forgets a remembered Design folder the user actually deleted", async () => {
    const root = await singleDesignFixture();
    const design = path.join(root, "Zeros Design");
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
    ).resolves.toBeUndefined();
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

  it("does not create the default Design directory for a code-only workspace", async () => {
    const root = await prospectiveDesignFixture();
    await writeFile(path.join(root, ".zeros", "settings.toml"), "");
    const defaultDesignRoot = path.join(root, "Zeros Design");

    expect(
      await resolveCodeAgentTerritory({
        cwd: path.join(root, "src"),
        workspaceRoot: root,
        repoRoot: root,
      }),
    ).toBeUndefined();
    expect(existsSync(defaultDesignRoot)).toBe(false);
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
        path.join(root, ".zeros"),
        path.join(root, ".git"),
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

  it("protects both linked-worktree and common Git metadata", async () => {
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

    expect(territory!.writeCapabilities.deniedPaths).toEqual(
      expect.arrayContaining([
        path.join(canonicalWorktree, ".git"),
        gitDir,
        commonDir,
      ]),
    );
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

  it("does not require a provider-specific sandbox once uniform ZSR is available", async () => {
    const root = await fixture();
    const admission = gateway() as unknown as TerritoryAdmission;
    const unsupported = {
      agentId: "unsupported",
      enforcesFilesystemTerritory: false,
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
      newSession: vi.fn(),
    } as unknown as AgentAdapter;
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      adapter,
    );

    await expect(
      gw.newSession("contained", { cwd: path.join(root, "src") }),
    ).rejects.toMatchObject({
      failure: {
        kind: "protocol-error",
        stage: "newSession",
        agentId: "contained",
      },
    });
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
    );
    expect(adapter.newSession).not.toHaveBeenCalled();
  });

  it("subtracts Design authority from an attached workspace and tracks its lifecycle owner", async () => {
    const primary = await prospectiveDesignFixture();
    await writeFile(path.join(primary, ".zeros", "settings.toml"), "");
    const attached = await singleDesignFixture();
    const onPrepare = vi.fn();
    let adapterTerritory: AgentFilesystemTerritory | undefined;
    const gw = gateway(testExecutionBoundary({ onPrepare }));
    const adapter = {
      agentId: "contained",
      newSession: vi.fn(
        async (opts: {
          executionId?: string;
          territory?: AgentFilesystemTerritory;
        }) => {
          adapterTerritory = opts.territory;
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
      env: { ZEROS_ADDITIONAL_DIRS: JSON.stringify([attached]) },
    });
    const attachedDesign = path.join(attached, "Zeros Design");

    expect(onPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceRoot: primary,
        additionalReadWriteRoots: [attached],
        additionalGitWorkspaceRoots: [attached],
        territory: expect.objectContaining({
          workspaceRoot: primary,
          protectedDesignDirectories: [attachedDesign],
          writeCapabilities: expect.objectContaining({
            deniedPaths: expect.arrayContaining([
              attachedDesign,
              path.join(attached, ".git"),
            ]),
          }),
        }),
      }),
    );
    expect(adapterTerritory?.protectedDesignDirectories).toEqual([
      attachedDesign,
    ]);
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

  it("preflights the exact territory without publishing it or creating a session", async () => {
    const root = await fixture();
    const onProbe = vi.fn();
    const gw = gateway(testExecutionBoundary({ onProbe }));
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      {
        agentId: "contained",
      } as unknown as AgentAdapter,
    );

    const status = await gw.preflightSession("contained", {
      cwd: path.join(root, "src"),
    });

    expect(status).toMatchObject({
      state: "ready",
      backend: "zeros-srt",
      designProtection: {
        required: true,
        enforced: true,
        protectedDirectoryCount: 2,
      },
      parity: {
        level: "full",
        restrictions: [],
      },
    });
    expect(status.designProtection.territoryGeneration).toBeUndefined();
    expect(onProbe).toHaveBeenCalledOnce();
    expect(onProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "agent-code",
        workspaceRoot: root,
        territory: expect.objectContaining({
          protectedDesignDirectories: [
            path.join(root, "Product Design"),
            path.join(root, "Zeros Design"),
          ],
        }),
      }),
    );
    const request = onProbe.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("providerId");
    expect(request).not.toHaveProperty("providerStateEnv");
    expect(request).not.toHaveProperty("containerWorker");
    expect(request?.localServices ?? []).toEqual([]);
    expect(request?.allowedLocalPorts ?? []).toEqual([]);
    expect(designDirectoryNameFor(root)).toBe("Zeros Design");
  });

  it("returns actionable unavailable preflight state instead of downgrading", async () => {
    const root = await fixture();
    const gw = gateway(
      testExecutionBoundary({
        probeResult: {
          backend: "zeros-srt",
          available: false,
          secureNestedIsolation: false,
          reasons: ["qualified backend is unavailable"],
        },
      }),
    );
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "unsupported",
      {
        agentId: "unsupported",
      } as AgentAdapter,
    );

    const status = await gw.preflightSession("unsupported", {
      cwd: path.join(root, "src"),
    });

    expect(status).toMatchObject({
      state: "unavailable",
      designProtection: { required: true, enforced: false },
    });
    expect(status.remediation).toMatch(/qualified Zeros sandbox backend/i);
  });

  it("does not blame Design settings when private provider state admission fails", async () => {
    const root = await fixture();
    const gw = gateway(
      testExecutionBoundary({
        prepareError: new Error(
          "provider overlay exceeds its bounded snapshot quota",
        ),
      }),
    );
    (gw as unknown as { adapters: Map<string, AgentAdapter> }).adapters.set(
      "contained",
      { agentId: "contained" } as AgentAdapter,
    );

    const status = await gw.preflightSession("contained", {
      cwd: path.join(root, "src"),
    });

    expect(status.state).toBe("unavailable");
    expect(status.remediation).toMatch(/private provider state/i);
    expect(status.remediation).not.toMatch(/Design directory/i);
  });
});
