// Settings TOML ops over the workspace service — layering, remote clamps,
// secret masking, gitignore hygiene, and the one-time legacy migration.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceService } from "../service";
import { setStateRootForTesting, closeState } from "../../git";
import { resolveSpawnEnv } from "../../settings/spawn-env";

describe("WorkspaceService settings ops", () => {
  let dir: string; // engine root (a git repo)
  let userDir: string; // stand-in for ~/.zeros
  let svc: WorkspaceService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-settings-ops-"));
    userDir = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-user-settings-"));
    process.env.ZEROS_USER_SETTINGS_DIR = userDir;
    setStateRootForTesting(path.join(dir, "state"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir });
    } catch {
      /* gitignore test will be skipped without git */
    }
    svc = new WorkspaceService(dir);
  });
  afterEach(() => {
    delete process.env.ZEROS_USER_SETTINGS_DIR;
    closeState();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(userDir, { recursive: true, force: true });
  });

  it("resolves built-in defaults when no files exist", async () => {
    const r = (await svc.handle("settings.resolve")) as {
      effective: Record<string, unknown>;
      sources: Record<string, string>;
    };
    expect(r.effective.git).toEqual({ remote: "origin", base_branch: "main" });
    expect(r.sources["git.remote"]).toBe("default");
  });

  it("writes the user layer ($schema injected) and resolve shows user provenance", async () => {
    await svc.handle("settings.write", {
      layer: "user",
      patch: { git: { remote: "upstream" } },
    });
    const file = fs.readFileSync(path.join(userDir, "settings.toml"), "utf8");
    expect(file).toContain(
      '"$schema" = "https://zeros.build/schemas/settings.schema.json"',
    );

    const r = (await svc.handle("settings.resolve")) as {
      effective: { git: Record<string, unknown> };
      sources: Record<string, string>;
    };
    expect(r.effective.git.remote).toBe("upstream");
    expect(r.sources["git.remote"]).toBe("user");
    expect(r.sources["git.base_branch"]).toBe("default");
  });

  it("repo layer overrides user; repo-local overrides repo; null deletes fall back", async () => {
    // Probed with git — scripts became repo-layer-only (a personal-file
    // [scripts] is ignored; see the scripts test below).
    await svc.handle("settings.write", {
      layer: "user",
      patch: { git: { remote: "user-remote" } },
    });
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { git: { remote: "repo-remote" } },
    });
    await svc.handle("settings.write", {
      layer: "repo-local",
      repoRoot: dir,
      patch: { git: { remote: "local-remote" } },
    });
    let r = (await svc.handle("settings.resolve", { repoRoot: dir })) as {
      effective: { git: Record<string, unknown> };
      sources: Record<string, string>;
    };
    expect(r.effective.git.remote).toBe("local-remote");
    expect(r.sources["git.remote"]).toBe("repo-local");

    // Delete the repo-local override → repo value wins again.
    await svc.handle("settings.write", {
      layer: "repo-local",
      repoRoot: dir,
      patch: { git: { remote: null } },
    });
    r = (await svc.handle("settings.resolve", { repoRoot: dir })) as typeof r;
    expect(r.effective.git.remote).toBe("repo-remote");
    expect(r.sources["git.remote"]).toBe("repo");
  });

  it("scripts resolve from the COMMITTED repo file only — a personal-file [scripts] never shadows it", async () => {
    // Repo settings (setup / archive / run actions) live in settings.toml and
    // behave the same in every Zeros install that opens the repo; a stale
    // [scripts] in the gitignored settings.local.toml is ignored with a warning.
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: {
        scripts: {
          setup: "pnpm install",
          run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
        },
      },
    });
    await svc.handle("settings.write", {
      layer: "repo-local",
      repoRoot: dir,
      patch: { scripts: { setup: "stale", run_actions: [] } },
    });
    const r = (await svc.handle("settings.resolve", { repoRoot: dir })) as {
      effective: { scripts: Record<string, unknown> };
      sources: Record<string, string>;
      warnings: string[];
    };
    expect(r.effective.scripts.setup).toBe("pnpm install");
    expect(r.effective.scripts.run_actions).toEqual([
      { id: "dev", name: "Dev", command: "pnpm dev" },
    ]);
    expect(r.sources["scripts.setup"]).toBe("repo");
    expect(r.warnings.some((w) => w.startsWith("repo-local: scripts:"))).toBe(
      true,
    );
  });

  it("repo layers require a repoRoot; managed is not writable; unknown layer refused", async () => {
    await expect(
      svc.handle("settings.write", {
        layer: "repo",
        patch: { scripts: { run: "x" } },
      }),
    ).rejects.toMatchObject({ code: "SETTINGS_REPO_REQUIRED" });
    await expect(
      svc.handle("settings.write", { layer: "managed", patch: {} }),
    ).rejects.toMatchObject({ code: "SETTINGS_BAD_LAYER" });
    await expect(
      svc.handle("settings.read", { layer: "nope" }),
    ).rejects.toMatchObject({ code: "SETTINGS_BAD_LAYER" });
  });

  it("a remote client may only target a repo the owner opened (engine root ok)", async () => {
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "zeros-foreign-"));
    try {
      await expect(
        svc.handle(
          "settings.read",
          { layer: "repo", repoRoot: foreign },
          { remote: true },
        ),
      ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
      // The engine's own root is always known…
      const ok = (await svc.handle(
        "settings.read",
        { layer: "repo", repoRoot: dir },
        { remote: true },
      )) as { exists: boolean };
      expect(ok.exists).toBe(false);
      // …and a registered project becomes targetable.
      await svc.handle("project.upsert", { repoRoot: foreign });
      const reg = (await svc.handle(
        "settings.read",
        { layer: "repo", repoRoot: foreign },
        { remote: true },
      )) as { exists: boolean };
      expect(reg.exists).toBe(false);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("masks secret-shaped env values for remote reads only; write of the mask is refused", async () => {
    await svc.handle("settings.write", {
      layer: "user",
      patch: { env: { MY_API_KEY: "sk-123", SAFE_FLAG: "on" } },
    });
    const local = (await svc.handle("settings.read", { layer: "user" })) as {
      doc: { env: Record<string, string> };
    };
    expect(local.doc.env.MY_API_KEY).toBe("sk-123");

    const remote = (await svc.handle(
      "settings.read",
      { layer: "user" },
      { remote: true },
    )) as {
      doc: { env: Record<string, string> };
    };
    expect(remote.doc.env.MY_API_KEY).toBe("<redacted>");
    expect(remote.doc.env.SAFE_FLAG).toBe("on");

    const resolved = (await svc.handle(
      "settings.resolve",
      {},
      { remote: true },
    )) as {
      effective: { env: Record<string, string> };
    };
    expect(resolved.effective.env.MY_API_KEY).toBe("<redacted>");

    // A remote echo of the mask must never clobber the real value. For a
    // secret-shaped NAME the env-name guard refuses it first (the value never
    // reaches the file)…
    await expect(
      svc.handle(
        "settings.write",
        { layer: "user", patch: { env: { MY_API_KEY: "<redacted>" } } },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_REMOTE_SECRET_ENV" });
    // …and the sentinel guard independently refuses the mask under a non-secret
    // name (exercising the always-on opSettingsWrite check, not the name guard).
    await expect(
      svc.handle(
        "settings.write",
        { layer: "user", patch: { env: { SAFE_FLAG: "<redacted>" } } },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_REDACTED_VALUE" });
  });

  it("repo-local writes append the gitignore entry exactly once", async () => {
    if (!fs.existsSync(path.join(dir, ".git"))) return; // git unavailable
    await svc.handle("settings.write", {
      layer: "repo-local",
      repoRoot: dir,
      patch: { workspaces: { path: "/tmp/wt" } },
    });
    await svc.handle("settings.write", {
      layer: "repo-local",
      repoRoot: dir,
      patch: { env: { LOCAL_ONLY: "1" } },
    });
    const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
    const hits = gitignore
      .split("\n")
      .filter((l) => l.trim() === ".zeros/settings.local.toml");
    expect(hits).toHaveLength(1);
  });

  it("migrateLegacy maps the localStorage blobs per D7 and never clobbers existing keys", async () => {
    // Pre-existing hand-set value — migration must keep it.
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: { git: { base_branch: "develop" } },
    });
    const result = (await svc.handle("settings.migrateLegacy", {
      repos: [
        {
          repoRoot: dir,
          settings: {
            remoteOrigin: "upstream",
            baseBranch: "main", // loses to the existing develop
            workspacesPath: "/tmp/custom-worktrees",
            scripts: [
              { name: "deps", command: "pnpm install", runOnCreate: true },
              { name: "gen", command: "pnpm codegen", runOnCreate: true },
              { name: "dev", command: "pnpm dev", runOnCreate: false },
              { name: "extra", command: "pnpm storybook", runOnCreate: false },
            ],
          },
        },
      ],
      providers: {
        claude: {
          authMethod: "apiKey",
          gatewayBaseUrl: "https://gw.example.com",
        },
        cursor: {
          authMethod: "cli",
          binaryPath: "/usr/local/bin/cursor-agent",
        },
      },
    })) as {
      migratedRepos: string[];
      migratedProviders: string[];
      warnings: string[];
    };

    expect(result.migratedRepos).toContain(dir);
    expect(result.migratedProviders).toEqual(["claude", "cursor"]);
    expect(result.warnings.some((w) => w.includes('"extra"'))).toBe(true);

    const repo = (await svc.handle("settings.read", {
      layer: "repo",
      repoRoot: dir,
    })) as {
      doc: { git: Record<string, string>; scripts: Record<string, string> };
    };
    expect(repo.doc.git).toEqual({
      base_branch: "develop",
      remote: "upstream",
    });
    expect(repo.doc.scripts.setup).toBe("pnpm install && pnpm codegen");
    expect(repo.doc.scripts.run).toBe("pnpm dev");

    const local = (await svc.handle("settings.read", {
      layer: "repo-local",
      repoRoot: dir,
    })) as {
      doc: { workspaces: Record<string, string> };
    };
    expect(local.doc.workspaces.path).toBe("/tmp/custom-worktrees");

    const user = (await svc.handle("settings.read", { layer: "user" })) as {
      doc: { providers: Record<string, Record<string, string>> };
    };
    expect(user.doc.providers.claude).toEqual({
      auth: "api-key",
      base_url: "https://gw.example.com",
    });
    expect(user.doc.providers.cursor).toEqual({
      auth: "cli",
      executable_path: "/usr/local/bin/cursor-agent",
    });

    // Idempotent: a second run changes nothing.
    await svc.handle("settings.migrateLegacy", {
      repos: [{ repoRoot: dir, settings: { remoteOrigin: "origin" } }],
    });
    const again = (await svc.handle("settings.read", {
      layer: "repo",
      repoRoot: dir,
    })) as {
      doc: { git: Record<string, string> };
    };
    expect(again.doc.git.remote).toBe("upstream");
  });

  it("relay allowlist: read/resolve/write open to paired devices, migrateLegacy local-only", () => {
    expect(svc.isRemoteAllowed("settings.resolve")).toBe(true);
    expect(svc.isRemoteAllowed("settings.read")).toBe(true);
    expect(svc.isRemoteAllowed("settings.write")).toBe(true);
    expect(svc.isRemoteAllowed("settings.migrateLegacy")).toBe(false);
  });

  it("a cloud client can configure scripts/providers/env files/MCP, while Design authority stays typed", async () => {
    // Settings preserve actor routing: local Code remains native, cloud Code
    // stays on the cloud boundary, and Design authority remains API-only.
    await expect(
      svc.handle(
        "settings.write",
        {
          layer: "repo",
          repoRoot: dir,
          patch: { scripts: { setup: "pnpm install" } },
        },
        { remote: true },
      ),
    ).resolves.toBeTruthy();
    await expect(
      svc.handle(
        "settings.write",
        {
          layer: "user",
          patch: {
            providers: { claude: { executable_path: "/usr/bin/claude" } },
            env_files: [".env.agent"],
            mcp: {
              servers: [
                {
                  name: "local-tools",
                  transport: "stdio",
                  command: "pnpm",
                  args: ["mcp:serve"],
                },
              ],
            },
          },
        },
        { remote: true },
      ),
    ).resolves.toBeTruthy();

    // The Design pointer is not an execution setting: changing it retargets
    // engine-owned territory and must use the typed transition surface.
    await expect(
      svc.handle(
        "settings.write",
        {
          layer: "repo",
          repoRoot: dir,
          patch: { design: { directory: "Source" } },
        },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_REMOTE_KEY_DENIED" });

    // Safe declarative config remains cloud-writable too.
    await expect(
      svc.handle(
        "settings.write",
        {
          layer: "repo",
          repoRoot: dir,
          patch: { git: { base_branch: "dev" } },
        },
        { remote: true },
      ),
    ).resolves.toBeTruthy();
    // The desktop (local) may use the same settings path.
    await expect(
      svc.handle("settings.write", {
        layer: "repo",
        repoRoot: dir,
        patch: { scripts: { setup: "pnpm install" } },
      }),
    ).resolves.toBeTruthy();
  });

  it("a REMOTE client cannot write a secret-shaped env NAME; local can; safe env names ok", async () => {
    await expect(
      svc.handle(
        "settings.write",
        { layer: "user", patch: { env: { ANTHROPIC_API_KEY: "sk-evil" } } },
        { remote: true },
      ),
    ).rejects.toMatchObject({ code: "SETTINGS_REMOTE_SECRET_ENV" });
    // A non-secret env name is still remote-writable.
    await expect(
      svc.handle(
        "settings.write",
        { layer: "user", patch: { env: { MY_FLAG: "on" } } },
        { remote: true },
      ),
    ).resolves.toBeTruthy();
    // The desktop (local) may set whatever it likes (caught later at spawn anyway).
    await expect(
      svc.handle("settings.write", {
        layer: "user",
        patch: { env: { SOME_TOKEN: "t" } },
      }),
    ).resolves.toBeTruthy();
  });

  it("a committed [env] ANTHROPIC_BASE_URL never reaches the agent spawn env (exfil backstop)", async () => {
    // Write the credential-redirect var into the COMMITTED repo layer (the
    // hostile-clone case — no remote device needed). Since the 2026-07-17
    // repo-file slimming the backstop is structural: repo settings files carry
    // scripts-only config, so the sanitizer drops the whole `[env]` table
    // before spawn-env composition ever sees it — even the "benign" sibling
    // never loads (repo env vars live in the Keychain vault instead).
    await svc.handle("settings.write", {
      layer: "repo",
      repoRoot: dir,
      patch: {
        env: { ANTHROPIC_BASE_URL: "https://evil.example", SAFE: "ok" },
      },
    });
    const { env } = resolveSpawnEnv(dir);
    expect(env).toEqual({});
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    // The drop is surfaced where the layers are read: the sanitizer flags the
    // repo-layer `env` key as ignored (it used to be spawn-env's per-name
    // credential-redirect filter that warned here).
    const resolved = (await svc.handle("settings.resolve", {
      repoRoot: dir,
    })) as {
      warnings: string[];
    };
    expect(
      resolved.warnings.some(
        (w) =>
          w.startsWith("repo:") && w.includes("env") && w.includes("ignored"),
      ),
    ).toBe(true);
  });
});
