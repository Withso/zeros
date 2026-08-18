import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentFilesystemTerritory } from "../../../types";
import {
  CODEX_CODE_TERRITORY_PROFILE,
  codexTerritoryConfig,
  codexTerritoryProfileOverride,
  runCodexTerritoryCommand,
} from "../territory";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  territory: AgentFilesystemTerritory;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "zeros-codex-territory-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "code"), { recursive: true }),
    mkdir(path.join(root, "Zeros Design", "nested"), { recursive: true }),
    mkdir(path.join(root, ".zeros"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(root, "code", "writable.txt"), "before\n"),
    writeFile(path.join(root, "Zeros Design", "existing.txt"), "before\n"),
    writeFile(path.join(root, "Zeros Design", "replace.txt"), "before\n"),
    writeFile(path.join(root, "Zeros Design", "draft.tmp"), "ignored\n"),
    writeFile(path.join(root, ".zeros", "settings.toml"), "[design]\n"),
  ]);
  await execFileAsync("git", ["init", "-q", "-b", "main"], { cwd: root });
  const territory: AgentFilesystemTerritory = {
    agentRole: "code",
    workspaceRoot: root,
    designDirectory: path.join(root, "Zeros Design"),
    protectedDesignDirectories: [path.join(root, "Zeros Design")],
    designRecognitionPaths: [],
    writeCapabilities: {
      workspace: "write",
      deniedPaths: [
        path.join(root, "Zeros Design"),
        path.join(root, ".zeros"),
        path.join(root, ".git"),
      ],
    },
  };
  return { root, territory };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Codex code-territory profile", () => {
  it("uses one canonical writable workspace with exact read-only carveouts", async () => {
    const { root, territory } = await fixture();
    const profile = codexTerritoryConfig(territory, ["safe", "bad.name"]);
    expect(profile.permissions).toEqual({
      [CODEX_CODE_TERRITORY_PROFILE]: {
        description: "Zeros code actor: workspace write with Design read-only",
        workspace_roots: { [root]: true },
        filesystem: {
          ":minimal": "read",
          ":workspace_roots": "write",
          [path.join(root, ".git")]: "read",
          [path.join(root, ".zeros")]: "read",
          [path.join(root, "Zeros Design")]: "read",
        },
        network: { enabled: true },
      },
    });
    expect(profile.mcp_servers).toEqual({ safe: { enabled: false } });
    expect(profile.features).toMatchObject({
      apps: false,
      hooks: false,
      plugins: false,
      multi_agent: false,
      request_permissions: false,
      tool_search: false,
    });
    const override = codexTerritoryProfileOverride(territory);
    expect(override).toContain(`workspace_roots={"${root}"=true}`);
    expect(override).toContain(`"${path.join(root, "Zeros Design")}"="read"`);
    expect(override).toContain("network={enabled=true}");
  });

  it("refuses an unqualified custom Codex executable", async () => {
    const { territory } = await fixture();
    await expect(
      runCodexTerritoryCommand(territory, ["--version"], {
        cliBinary: process.execPath,
      }),
    ).rejects.toThrow(/runtime pinned and shipped with this Zeros build/i);
  });

  const required = process.env.ZEROS_REQUIRE_CONTAINMENT_RUNTIME === "1";
  (required ? it : it.skip)(
    "blocks the complete shell/Git filesystem attack matrix in the real provider sandbox",
    async () => {
      const { root, territory } = await fixture();
      // Use the platform shell instead of `process.execPath`. Homebrew Node is
      // dynamically linked from its Cellar directory, which is intentionally
      // outside Codex's `:minimal` read set on macOS; asking the sandbox to
      // launch it would test host package layout rather than this territory.
      // Redirections plus mv/ln/git still exercise the kernel boundary used by
      // shell, patch, editor, and generic Git tools.
      const attack = String.raw`
        (printf 'after\n' > code/writable.txt) || true
        (printf 'overwrite\n' > 'Zeros Design/existing.txt') || true
        (printf 'append\n' >> 'Zeros Design/existing.txt') || true
        (printf '' > 'Zeros Design/existing.txt') || true
        (printf 'new\n' > 'Zeros Design/nested/new.txt') || true
        (printf 'changed\n' > 'Zeros Design/draft.tmp') || true
        (printf 'replacement\n' > code/replacement.tmp &&
          mv code/replacement.tmp 'Zeros Design/replace.txt') || true
        (mv 'Zeros Design/existing.txt' code/stolen.txt) || true
        (ln -s "$PWD/Zeros Design/existing.txt" code/design-link &&
          printf 'through-link\n' >> code/design-link) || true
        (ln 'Zeros Design/existing.txt' code/design-hardlink &&
          printf 'through-hardlink\n' >> code/design-hardlink) || true
        (printf 'changed\n' > .zeros/settings.toml) || true
        (printf 'changed\n' > .git/HEAD) || true
        (git add -- code/writable.txt) || true
        exit 0
      `;
      await runCodexTerritoryCommand(territory, ["/bin/sh", "-c", attack], {
        timeoutMs: 15_000,
      });
      await expect(
        readFile(path.join(root, "Zeros Design", "existing.txt"), "utf8"),
      ).resolves.toBe("before\n");
      await expect(
        readFile(path.join(root, "Zeros Design", "draft.tmp"), "utf8"),
      ).resolves.toBe("ignored\n");
      await expect(
        readFile(path.join(root, "code", "writable.txt"), "utf8"),
      ).resolves.toBe("after\n");
      await expect(
        readFile(path.join(root, "Zeros Design", "replace.txt"), "utf8"),
      ).resolves.toBe("before\n");
      await expect(
        readFile(path.join(root, ".zeros", "settings.toml"), "utf8"),
      ).resolves.toBe("[design]\n");
      await expect(
        readFile(path.join(root, ".git", "HEAD"), "utf8"),
      ).resolves.toMatch(/^ref: refs\/heads\/main\s*$/);
      const staged = await execFileAsync(
        "git",
        ["diff", "--cached", "--name-only"],
        { cwd: root },
      );
      expect(staged.stdout.trim()).toBe("");
    },
  );
});
