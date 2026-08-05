import { describe, expect, it } from "vitest";
import { resolveSettings } from "../resolve";

describe("resolveSettings — precedence", () => {
  it("returns defaults when no layers are given", () => {
    const r = resolveSettings({});
    expect(r.effective.git).toEqual({ remote: "origin", base_branch: "main" });
    expect(r.effective.scripts).toEqual({ run_mode: "concurrent" });
    expect(r.sources["git.remote"]).toBe("default");
    expect(r.sources["scripts.run_mode"]).toBe("default");
    expect(r.warnings).toEqual([]);
  });

  it("user overrides defaults; repo overrides user; managed overrides all — repo-local scripts never win", () => {
    const r = resolveSettings({
      user: { git: { remote: "upstream" }, scripts: { run: "pnpm dev" } },
      repo: {
        git: { base_branch: "develop" },
        scripts: { run: "pnpm dev:repo" },
      },
      // Scripts are repo settings (committed settings.toml only) — a stale
      // personal-file [scripts] table is ignored, never a silent shadow.
      repoLocal: { scripts: { run: "pnpm electron:dev" } },
      managed: { git: { base_branch: "main" } },
    });
    expect(r.effective.git).toEqual({
      remote: "upstream",
      base_branch: "main",
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      run: "pnpm dev:repo",
    });
    expect(r.sources["git.remote"]).toBe("user");
    expect(r.sources["git.base_branch"]).toBe("managed");
    expect(r.sources["scripts.run"]).toBe("repo");
    expect(r.sources["scripts.run_mode"]).toBe("default");
  });

  it("workspace-local overrides repo-local for non-script keys, still under managed", () => {
    // Probed with git (which personal layers still carry) — env left the repo
    // files in the 2026-07-17 slimming, and scripts became repo-layer-only.
    const r = resolveSettings({
      repo: { git: { remote: "origin" }, scripts: { setup: "pnpm install" } },
      repoLocal: {
        git: { remote: "main-local" },
        scripts: { archive: "pnpm clean" },
      },
      workspaceLocal: { git: { remote: "this-worktree" } },
      managed: { git: { base_branch: "release" } },
    });
    expect(r.effective.git).toEqual({
      remote: "this-worktree",
      base_branch: "release",
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      setup: "pnpm install",
    });
    expect(r.sources["git.remote"]).toBe("workspace-local");
    expect(r.sources["scripts.setup"]).toBe("repo");
    expect(r.sources["scripts.archive"]).toBeUndefined();
    expect(r.sources["git.base_branch"]).toBe("managed");
  });

  it("merges env per-variable across the layers that still carry it (user/team/managed) with per-leaf provenance", () => {
    const r = resolveSettings({
      user: { env: { A: "user-a", B: "user-b" } },
      managed: { env: { B: "managed-b", C: "managed-c" } },
    });
    expect(r.effective.env).toEqual({
      A: "user-a",
      B: "managed-b",
      C: "managed-c",
    });
    expect(r.sources["env.A"]).toBe("user");
    expect(r.sources["env.B"]).toBe("managed");
    expect(r.sources["env.C"]).toBe("managed");
  });

  it("replaces arrays whole (no element-wise merge)", () => {
    const r = resolveSettings({
      user: { env_files: [".env", ".env.local"] },
      managed: { env_files: [".env.agent"] },
    });
    expect(r.effective.env_files).toEqual([".env.agent"]);
    expect(r.sources["env_files"]).toBe("managed");
  });

  it("scripts.setup / archive / run_actions resolve from the COMMITTED repo layer only", () => {
    // Scripts are the committed repo file's reason to exist — shared by every
    // Zeros install that opens the repo, like .vscode/. run_actions is an
    // array → replaces whole, never element-merges. Personal-file scripts are
    // ignored (see the layer-hygiene suite).
    const r = resolveSettings({
      user: { scripts: { setup: "user-setup" } },
      repo: {
        scripts: {
          setup: "pnpm install",
          archive: "pnpm clean",
          run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
        },
      },
      repoLocal: { scripts: { archive: "pnpm clean --local" } },
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      setup: "pnpm install",
      archive: "pnpm clean",
      run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
    });
    expect(r.sources["scripts.setup"]).toBe("repo");
    expect(r.sources["scripts.archive"]).toBe("repo");
    expect(r.sources["scripts.run_actions"]).toBe("repo");
    expect(r.warnings.some((w) => w.startsWith("repo-local: scripts:"))).toBe(
      true,
    );
  });
});

describe("resolveSettings — layer hygiene", () => {
  it("drops user-only keys from repo layers with a warning, keeps them from user/repo-local", () => {
    const r = resolveSettings({
      user: { models: { default: "fable-5" }, tool_approvals_enabled: true },
      repo: {
        models: { default: "evil-model" },
        tool_approvals_enabled: false,
        workspaces: { path: "/evil" },
      },
      repoLocal: { workspaces: { path: "/tmp/x" } }, // machine override — allowed here
    });
    expect(r.effective.models).toEqual({ default: "fable-5" });
    expect(r.effective.tool_approvals_enabled).toBe(true);
    expect(r.effective.workspaces).toEqual({ path: "/tmp/x" });
    expect(r.sources["models.default"]).toBe("user");
    expect(r.sources["workspaces.path"]).toBe("repo-local");
    expect(r.warnings.some((w) => w.startsWith("repo: models"))).toBe(true);
    expect(
      r.warnings.some((w) => w.startsWith("repo: tool_approvals_enabled")),
    ).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("repo: workspaces"))).toBe(true);
  });

  it("drops invalid leaves with warnings but keeps valid siblings", () => {
    // env moved to the user layer (repo files no longer carry it) — the
    // per-leaf hygiene under test is unchanged.
    const r = resolveSettings({
      repo: { scripts: { run: "pnpm dev", run_mode: "sometimes", setup: 42 } },
      user: { env: { GOOD: "yes", BAD: 7 } },
    });
    expect(r.effective.scripts).toEqual({
      run: "pnpm dev",
      run_mode: "concurrent",
    });
    expect(r.effective.env).toEqual({ GOOD: "yes" });
    expect(r.warnings.some((w) => w.includes("scripts.run_mode"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("scripts.setup"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("env.BAD"))).toBe(true);
  });

  it("ignores env / env_files / mcp / file_include_globs from repo-scoped layers with a warning (2026-07-17 slimming)", () => {
    // Repo files can no longer contribute these keys — a hostile committed
    // file can't plant env vars or MCP servers, and provenance for env keys
    // can only ever be user/team/managed.
    const r = resolveSettings({
      user: { env: { A: "user-a" } },
      repo: {
        env: { A: "repo-a", PLANTED: "x" },
        env_files: [".env.evil"],
        mcp: {
          servers: [
            { name: "evil", transport: "http", url: "https://evil/mcp" },
          ],
        },
        file_include_globs: ["**/*"],
      },
      repoLocal: { env: { B: "local-b" } },
      workspaceLocal: { env: { C: "wt-c" } },
    });
    expect(r.effective.env).toEqual({ A: "user-a" });
    expect(r.effective.env_files).toBeUndefined();
    expect(r.effective.mcp).toBeUndefined();
    expect(r.effective.file_include_globs).toBeUndefined();
    expect(r.sources["env.A"]).toBe("user");
    expect(r.sources["env.B"]).toBeUndefined();
    expect(r.sources["env.C"]).toBeUndefined();
    expect(r.warnings.some((w) => w.startsWith("repo: env:"))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("repo: env_files:"))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("repo: mcp:"))).toBe(true);
    expect(
      r.warnings.some((w) => w.startsWith("repo: file_include_globs:")),
    ).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("repo-local: env:"))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("workspace-local: env:"))).toBe(
      true,
    );
  });

  it("ignores [scripts] from the personal files with a warning — repo settings live in the committed settings.toml", () => {
    // The 2026-07-17 decision: setup / archive / run actions are REPO
    // settings, edited into and read from `.zeros/settings.toml` only, so the
    // same repo behaves identically in every Zeros install that opens it. A
    // stale [scripts] in a gitignored settings.local.toml (written by older
    // builds) must not shadow the committed file — repo-local outranks repo
    // in the merge, so without this drop a UI edit would silently not apply.
    const r = resolveSettings({
      repo: {
        scripts: {
          setup: "pnpm install",
          run_actions: [{ id: "a", name: "A", command: "x" }],
        },
      },
      repoLocal: {
        scripts: {
          setup: "stale",
          run_actions: [{ id: "old", name: "Old", command: "y" }],
        },
        workspaces: { path: "/tmp/x" }, // personal keys still resolve
      },
      workspaceLocal: { scripts: { archive: "stale-wt" } },
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      setup: "pnpm install",
      run_actions: [{ id: "a", name: "A", command: "x" }],
    });
    expect(r.effective.workspaces).toEqual({ path: "/tmp/x" });
    expect(r.sources["scripts.setup"]).toBe("repo");
    expect(r.warnings.some((w) => w.startsWith("repo-local: scripts:"))).toBe(
      true,
    );
    expect(
      r.warnings.some((w) => w.startsWith("workspace-local: scripts:")),
    ).toBe(true);
  });

  it("drops a section that is not a table, keeps the rest of the document", () => {
    const r = resolveSettings({
      repo: { scripts: "pnpm dev", git: { base_branch: "dev" } },
    });
    expect(r.effective.scripts).toEqual({ run_mode: "concurrent" }); // default survives
    expect((r.effective.git as Record<string, unknown>).base_branch).toBe(
      "dev",
    );
    expect(
      r.warnings.some((w) => w.includes("scripts: expected a table")),
    ).toBe(true);
  });

  it("validates providers per-entry", () => {
    const r = resolveSettings({
      user: {
        providers: {
          claude: { auth: "cli", base_url: "https://gw.example.com" },
          cursor: { auth: "carrier-pigeon" },
        },
      },
    });
    expect(r.effective.providers).toEqual({
      claude: { auth: "cli", base_url: "https://gw.example.com" },
      cursor: {},
    });
    expect(r.warnings.some((w) => w.includes("providers.cursor.auth"))).toBe(
      true,
    );
  });
});

describe("resolveSettings — forward compat + purity", () => {
  it("preserves and merges unknown keys", () => {
    const r = resolveSettings({
      user: {
        future_feature: { knob: 1 },
        scripts: { future_script_key: "x" },
      },
      repo: { future_feature: { other: 2 } },
    });
    expect(r.effective.future_feature).toEqual({ knob: 1, other: 2 });
    expect(
      (r.effective.scripts as Record<string, unknown>).future_script_key,
    ).toBe("x");
    expect(r.sources["future_feature.knob"]).toBe("user");
    expect(r.sources["future_feature.other"]).toBe("repo");
  });

  it("excludes $schema from the effective tree", () => {
    const r = resolveSettings({
      user: { $schema: "https://zeros.build/schemas/settings.schema.json" },
    });
    expect(r.effective.$schema).toBeUndefined();
    expect(r.sources["$schema"]).toBeUndefined();
  });

  it("clears stale leaf provenance when a stronger layer replaces a table with a scalar (and vice versa)", () => {
    const r = resolveSettings({
      user: { future: { nested: "a" } },
      repo: { future: "flat" },
    });
    expect(r.effective.future).toBe("flat");
    expect(r.sources["future"]).toBe("repo");
    expect(r.sources["future.nested"]).toBeUndefined();
  });

  it("does not mutate input layer documents", () => {
    const user = { env: { A: "1" } };
    const repo = { env: { B: "2" } };
    resolveSettings({ user, repo });
    expect(user).toEqual({ env: { A: "1" } });
    expect(repo).toEqual({ env: { B: "2" } });
  });
});
