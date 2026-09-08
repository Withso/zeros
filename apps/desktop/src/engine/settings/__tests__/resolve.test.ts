import { describe, expect, it } from "vitest";
import { resolveSettings } from "../resolve";

describe("resolveSettings — precedence", () => {
  it("returns defaults when no layers are given", () => {
    const r = resolveSettings({});
    expect(r.effective.git).toEqual({ remote: "origin", base_branch: "main" });
    expect(r.effective.scripts).toEqual({ run_mode: "concurrent" });
    expect(r.effective.browser).toEqual({
      enabled: true,
      codex_enabled: true,
      claude_enabled: false,
      provider: "isolated",
      auto_open: true,
      show_agent_cursor: true,
      navigation_approval: "always-ask",
    });
    expect(r.effective.design).toBeUndefined();
    expect(r.sources["git.remote"]).toBe("default");
    expect(r.sources["scripts.run_mode"]).toBe("default");
    expect(r.warnings).toEqual([]);
  });

  it("does not expose the retired Design isolation setting as policy", () => {
    const r = resolveSettings({
      user: { design: { isolation: { mode: "sparse" } } },
      team: { design: { isolation: { mode: "sandbox" } } },
      repo: { design: { isolation: { mode: "sandbox" } } },
      repoLocal: {
        design: { isolation: { mode: "sandbox+hardening" } },
      },
      workspaceLocal: { design: { isolation: { mode: "sandbox" } } },
      managed: {
        design: { isolation: { mode: "sandbox+hardening" } },
      },
    });

    expect(r.effective.design).toBeUndefined();
    expect(r.sources["design.isolation.mode"]).toBeUndefined();
    expect(
      r.warnings.filter((warning) => warning.includes("design.isolation")),
    ).toHaveLength(5);
  });

  it("user overrides defaults; repo-local overrides user; managed overrides all", () => {
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
      run: "pnpm electron:dev",
    });
    expect(r.sources["git.remote"]).toBe("user");
    expect(r.sources["git.base_branch"]).toBe("managed");
    expect(r.sources["scripts.run"]).toBe("repo-local");
    expect(r.sources["scripts.run_mode"]).toBe("default");
  });

  it("workspace-local overrides repository defaults below managed policy", () => {
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
      archive: "pnpm clean",
    });
    expect(r.sources["git.remote"]).toBe("workspace-local");
    expect(r.sources["scripts.setup"]).toBeUndefined();
    expect(r.sources["scripts.archive"]).toBe("repo-local");
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

  it("scripts and run actions resolve from personal repository settings", () => {
    const r = resolveSettings({
      user: { scripts: { setup: "user-setup", archive: "user-clean" } },
      repoLocal: {
        scripts: {
          setup: "pnpm install",
          run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
        },
      },
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      setup: "pnpm install",
      archive: "user-clean",
      run_actions: [{ id: "dev", name: "Dev", command: "pnpm dev" }],
    });
    expect(r.sources["scripts.setup"]).toBe("repo-local");
    expect(r.sources["scripts.archive"]).toBe("user");
    expect(r.sources["scripts.run_actions"]).toBe("repo-local");
    expect(r.warnings).toEqual([]);
  });
});

describe("resolveSettings — layer hygiene", () => {
  it("keeps provider/model policy user-only while accepting personal repository preferences", () => {
    const r = resolveSettings({
      user: { models: { default: "fable-5" }, tool_approvals_enabled: true },
      repoLocal: {
        models: { default: "other" },
        tool_approvals_enabled: false,
        workspaces: { path: "/tmp/x" },
      },
    });
    expect(r.effective.models).toEqual({ default: "fable-5" });
    expect(r.effective.tool_approvals_enabled).toBe(true);
    expect(r.effective.workspaces).toEqual({ path: "/tmp/x" });
    expect(r.sources["workspaces.path"]).toBe("repo-local");
    expect(r.warnings.some((w) => w.startsWith("repo-local: models"))).toBe(
      true,
    );
    expect(
      r.warnings.some((w) =>
        w.startsWith("repo-local: tool_approvals_enabled"),
      ),
    ).toBe(true);
  });

  it("keeps external Claude Chrome opt-in while honoring legacy disablement", () => {
    const legacyEnabled = resolveSettings({
      user: { browser: { enabled: true } },
    });
    expect(legacyEnabled.effective.browser).toMatchObject({
      enabled: true,
      codex_enabled: true,
      claude_enabled: false,
    });
    expect(legacyEnabled.sources["browser.codex_enabled"]).toBe("user");
    expect(legacyEnabled.sources["browser.claude_enabled"]).toBe("default");

    const disabled = resolveSettings({
      user: {
        browser: { enabled: false, codex_enabled: true },
      },
      repoLocal: { browser: { enabled: true, provider: "isolated" } },
    });
    expect(disabled.effective.browser).toEqual({
      enabled: false,
      codex_enabled: true,
      claude_enabled: false,
      provider: "isolated",
      auto_open: true,
      show_agent_cursor: true,
      navigation_approval: "always-ask",
    });
    expect(disabled.sources["browser.enabled"]).toBe("user");
    expect(disabled.sources["browser.codex_enabled"]).toBe("user");
    expect(disabled.sources["browser.claude_enabled"]).toBe("user");
    expect(disabled.sources["browser.provider"]).toBe("default");
    expect(
      disabled.warnings.some((warning) =>
        warning.startsWith("repo-local: browser"),
      ),
    ).toBe(true);
  });

  it("lets a managed shared browser policy override weaker provider settings", () => {
    const resolved = resolveSettings({
      user: { browser: { codex_enabled: true, claude_enabled: true } },
      managed: { browser: { enabled: false } },
    });
    expect(resolved.effective.browser).toMatchObject({
      codex_enabled: false,
      claude_enabled: false,
    });
    expect(resolved.sources["browser.codex_enabled"]).toBe("managed");
    expect(resolved.sources["browser.claude_enabled"]).toBe("managed");
  });

  it("drops invalid leaves with warnings but keeps valid siblings", () => {
    // env moved to the user layer (repo files no longer carry it) — the
    // per-leaf hygiene under test is unchanged.
    const r = resolveSettings({
      repoLocal: {
        scripts: { run: "pnpm dev", run_mode: "sometimes", setup: 42 },
      },
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

  it("ignores repository env and retired shared/worktree settings", () => {
    const r = resolveSettings({
      user: { env: { A: "user-a" } },
      repo: { env: { A: "repo" }, mcp: { servers: [] } },
      repoLocal: { env: { B: "local" }, env_files: [".env"] },
      workspaceLocal: { env: { C: "worktree" } },
    });
    expect(r.effective.env).toEqual({ A: "user-a" });
    expect(r.effective.env_files).toBeUndefined();
    expect(r.effective.mcp).toBeUndefined();
    expect(r.sources["env.A"]).toBe("user");
    expect(r.warnings.some((w) => w.startsWith("repo-local: env:"))).toBe(true);
    expect(r.warnings.some((w) => w.startsWith("repo-local: env_files:"))).toBe(
      true,
    );
  });

  it("personal script overrides replace arrays and clearing them falls back to user defaults", () => {
    const user = {
      scripts: {
        setup: "default",
        run_actions: [{ id: "a", name: "A", command: "x" }],
      },
    };
    const r = resolveSettings({
      user,
      repoLocal: { scripts: { setup: "personal", run_actions: [] } },
    });
    expect(r.effective.scripts).toEqual({
      run_mode: "concurrent",
      setup: "personal",
      run_actions: [],
    });
    expect(r.sources["scripts.setup"]).toBe("repo-local");
    expect(r.warnings).toEqual([]);
    expect(
      resolveSettings({ user, repoLocal: {} }).effective.scripts,
    ).toMatchObject(user.scripts);
  });

  it("drops a section that is not a table, keeps the rest of the document", () => {
    const r = resolveSettings({
      repoLocal: { scripts: "pnpm dev", git: { base_branch: "dev" } },
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
      repoLocal: { future_feature: { other: 2 } },
    });
    expect(r.effective.future_feature).toEqual({ knob: 1, other: 2 });
    expect(
      (r.effective.scripts as Record<string, unknown>).future_script_key,
    ).toBe("x");
    expect(r.sources["future_feature.knob"]).toBe("user");
    expect(r.sources["future_feature.other"]).toBe("repo-local");
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
      repoLocal: { future: "flat" },
    });
    expect(r.effective.future).toBe("flat");
    expect(r.sources["future"]).toBe("repo-local");
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
