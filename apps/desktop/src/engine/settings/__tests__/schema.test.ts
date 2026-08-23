import { describe, expect, it } from "vitest";
import { REPO_FILE_UNSUPPORTED_KEYS, sanitizeLayer } from "../schema";

describe("sanitizeLayer", () => {
  it("keeps a fully valid repo document intact", () => {
    // The slimmed 2026-07-17 repo shape: $schema + scripts + the two tables the
    // repo-page tabs edit (git / prompts). env/env_files left the repo files.
    const doc = {
      $schema: "https://zeros.build/schemas/settings.repo.schema.json",
      scripts: {
        setup: "pnpm install",
        run: "pnpm dev",
        run_mode: "concurrent",
      },
      git: { remote: "origin", base_branch: "main" },
      prompts: { general: "be brief" },
    };
    const r = sanitizeLayer(doc, "repo");
    expect(r.doc).toEqual(doc);
    expect(r.warnings).toEqual([]);
  });

  it("drops unsupported keys from repo-scoped layers with a warning, keeping git/prompts (+ scripts committed-only, mcp repo-local-only)", () => {
    // 2026-07-17 repo-file slimming: repo-scoped files carry scripts config
    // (+ git / prompts); env vars live in the Keychain vault. Each stale key is
    // IGNORED with a warning — never silently. Scripts are additionally
    // COMMITTED-file-only: the personal local files drop them too, so a stale
    // [scripts] can't shadow the repo's settings.toml. 2026-07-22: `mcp`
    // returned to the REPO-LOCAL layer only (the Customize tab's per-repo
    // servers) — the committed file and workspace-local still drop it (the
    // clone-borne-file gate). 2026-07-29: `file_include_globs` returned on the
    // same terms — "Files to copy" is per-project, and repo-local is the
    // personal, gitignored file the settings pane already writes.
    const doc = {
      scripts: { setup: "pnpm install" },
      git: { base_branch: "main" },
      prompts: { general: "be brief" },
      env: { A: "1" },
      env_files: [".env.agent"],
      mcp: { servers: [{ name: "ctx", transport: "stdio", command: "npx" }] },
      file_include_globs: [".env*"],
    };
    for (const layer of ["repo", "repo-local", "workspace-local"] as const) {
      const r = sanitizeLayer(doc, layer);
      const scriptsKept = layer === "repo";
      const repoLocalOnly = layer === "repo-local";
      expect(r.doc).toEqual({
        ...(scriptsKept ? { scripts: { setup: "pnpm install" } } : {}),
        git: { base_branch: "main" },
        prompts: { general: "be brief" },
        ...(repoLocalOnly
          ? {
              mcp: {
                servers: [{ name: "ctx", transport: "stdio", command: "npx" }],
              },
              file_include_globs: [".env*"],
            }
          : {}),
      });
      expect(r.warnings).toHaveLength(
        REPO_FILE_UNSUPPORTED_KEYS.length -
          (repoLocalOnly ? 2 : 0) +
          (scriptsKept ? 0 : 1),
      );
      for (const key of REPO_FILE_UNSUPPORTED_KEYS) {
        if (repoLocalOnly && (key === "mcp" || key === "file_include_globs"))
          continue;
        expect(
          r.warnings.some((w) => w.startsWith(`${key}:`) && w.includes(layer)),
        ).toBe(true);
      }
      if (!scriptsKept) {
        expect(
          r.warnings.some((w) => w.startsWith("scripts:") && w.includes(layer)),
        ).toBe(true);
      }
    }
  });

  it("KEEPS env / env_files / mcp / file_include_globs at the user layer", () => {
    // The slimming is repo-scoped only — the user file remains the (file-based)
    // home for these keys.
    const doc = {
      env: { A: "1" },
      env_files: [".env.agent"],
      mcp: { servers: [{ name: "ctx", transport: "stdio", command: "npx" }] },
      file_include_globs: [".env*"],
    };
    const r = sanitizeLayer(doc, "user");
    expect(r.doc).toEqual(doc);
    expect(r.warnings).toEqual([]);
  });

  it("non-table document → empty doc with warning", () => {
    expect(sanitizeLayer("nope", "user").doc).toEqual({});
    expect(sanitizeLayer("nope", "user").warnings).toHaveLength(1);
    expect(sanitizeLayer(undefined, "user")).toEqual({ doc: {}, warnings: [] });
  });

  it("filters env_files non-string entries, keeps the rest", () => {
    const r = sanitizeLayer({ env_files: [".env", 3, ".env.local"] }, "user");
    expect(r.doc.env_files).toEqual([".env", ".env.local"]);
    expect(r.warnings).toHaveLength(1);
  });

  it("user layer accepts user-only keys; repo layer rejects them all", () => {
    const doc = {
      models: { default: "fable-5" },
      workspaces: { path: "/x" },
      browser: {
        enabled: true,
        codex_enabled: false,
        claude_enabled: true,
        provider: "isolated",
        auto_open: false,
        show_agent_cursor: false,
      },
      tool_approvals_enabled: true,
      github: {
        auth_method: "github-app",
        disconnected_at: "2026-07-29T20:00:00.000Z",
      },
      providers: {
        claude: { auth: "api-key", executable_path: "/usr/local/bin/claude" },
      },
    };
    const user = sanitizeLayer(doc, "user");
    expect(user.doc).toEqual(doc);
    expect(user.warnings).toEqual([]);

    const repo = sanitizeLayer(doc, "repo");
    expect(repo.doc).toEqual({});
    expect(repo.warnings).toHaveLength(6);
  });

  it("keeps browser posture engine-owned and rejects provider escape hatches", () => {
    expect(
      sanitizeLayer(
        {
          browser: {
            enabled: false,
            codex_enabled: true,
            claude_enabled: false,
            provider: "isolated",
            auto_open: false,
            show_agent_cursor: true,
          },
        },
        "user",
      ),
    ).toEqual({
      doc: {
        browser: {
          enabled: false,
          codex_enabled: true,
          claude_enabled: false,
          provider: "isolated",
          auto_open: false,
          show_agent_cursor: true,
        },
      },
      warnings: [],
    });

    const invalid = sanitizeLayer(
      {
        browser: {
          enabled: true,
          provider: "shared-chrome",
          developer_cdp_enabled: true,
        },
      },
      "user",
    );
    expect(invalid.doc).toEqual({
      browser: { enabled: true },
    });
    expect(invalid.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("browser.provider"),
        expect.stringContaining("browser.developer_cdp_enabled"),
      ]),
    );

    const repo = sanitizeLayer(
      { browser: { enabled: true, provider: "isolated" } },
      "repo",
    );
    expect(repo.doc.browser).toBeUndefined();
    expect(repo.warnings).toEqual([expect.stringContaining("user-only")]);
  });

  it("round-trips every Models setting and validates Claude's idle timeout", () => {
    const models = {
      default: "claude-opus-4-8[1m]",
      default_agent: "claude",
      favorites: { claude: "claude-sonnet-5[1m]" },
      model_preferences: [
        {
          agent: "claude",
          model: "claude-opus-5[1m]",
          effort: "max",
          fast: true,
        },
      ],
      permission_preferences: [
        { agent: "claude", mode: "auto" },
        { agent: "codex", mode: "auto-edit" },
      ],
      chat_title_model: "claude-haiku-4-5",
      claude_code: {
        default_effort_level: "high",
        fallback_model: "claude-sonnet-5[1m]",
        budget_cap_usd: 5,
        idle_timeout_minutes: 300,
        auto_memory_enabled: false,
      },
    };

    expect(sanitizeLayer({ models }, "user")).toEqual({
      doc: { models },
      warnings: [],
    });

    const invalid = sanitizeLayer(
      {
        models: {
          claude_code: {
            fallback_model: "none",
            idle_timeout_minutes: 301,
            auto_memory_enabled: "yes",
          },
        },
      },
      "user",
    );
    expect(invalid.doc).toEqual({
      models: { claude_code: { fallback_model: "none" } },
    });
    expect(invalid.warnings).toEqual([
      expect.stringContaining("models.claude_code.idle_timeout_minutes"),
      expect.stringContaining("models.claude_code.auto_memory_enabled"),
    ]);
  });

  it("sanitizes bounded per-agent permission preferences independently", () => {
    const result = sanitizeLayer(
      {
        models: {
          permission_preferences: [
            { agent: "codex", mode: "ask" },
            { agent: "", mode: "auto" },
            { agent: "claude", mode: 42 },
            { agent: "codex", mode: "full-access" },
          ],
        },
      },
      "user",
    );

    expect(result.doc).toEqual({
      models: {
        permission_preferences: [{ agent: "codex", mode: "full-access" }],
      },
    });
    expect(result.warnings).toHaveLength(2);
  });

  it("keeps only the newest 32 distinct permission owners", () => {
    const preferences = Array.from({ length: 35 }, (_, index) => ({
      agent: `extension-${index}`,
      mode: `mode-${index}`,
    }));
    const result = sanitizeLayer(
      { models: { permission_preferences: preferences } },
      "user",
    );

    expect(result.doc).toEqual({
      models: { permission_preferences: preferences.slice(3) },
    });
    expect(result.warnings).toEqual([
      expect.stringContaining(
        "limited to the most recent 32 valid entries — 3 older entries ignored",
      ),
    ]);
  });

  it("drops only malformed per-model preferences and keeps valid siblings", () => {
    const result = sanitizeLayer(
      {
        models: {
          model_preferences: [
            { agent: "codex", model: "gpt-5.6-sol", effort: "max", fast: true },
            { agent: "codex", model: "", effort: "high", fast: false },
            {
              agent: "claude",
              model: "claude-opus-5[1m]",
              effort: "impossible",
            },
            { agent: "cursor", model: "composer-2.5" },
          ],
        },
      },
      "user",
    );

    expect(result.doc).toEqual({
      models: {
        model_preferences: [
          { agent: "codex", model: "gpt-5.6-sol", effort: "max", fast: true },
        ],
      },
    });
    expect(result.warnings).toHaveLength(3);
  });

  it("keeps the newest 128 valid model preferences and lets the last duplicate win", () => {
    const result = sanitizeLayer(
      {
        models: {
          model_preferences: [
            {
              agent: "codex",
              model: "gpt-5.6-sol",
              effort: "low",
            },
            ...Array.from({ length: 130 }, () => ({
              agent: "",
              model: "corrupt",
            })),
            {
              agent: "codex",
              model: "gpt-5.6-sol",
              effort: "max",
              fast: true,
            },
          ],
        },
      },
      "user",
    );

    expect(result.doc).toEqual({
      models: {
        model_preferences: [
          {
            agent: "codex",
            model: "gpt-5.6-sol",
            effort: "max",
            fast: true,
          },
        ],
      },
    });
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("drops an invalid GitHub method without dropping its valid siblings", () => {
    const r = sanitizeLayer(
      {
        github: {
          auth_method: "oauth",
          disconnected_at: "2026-07-29T20:00:00.000Z",
        },
      },
      "user",
    );
    expect(r.doc).toEqual({
      github: { disconnected_at: "2026-07-29T20:00:00.000Z" },
    });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("github.auth_method");
  });

  it("repo-local layer allows workspaces (machine-specific override) but not models/approvals/providers", () => {
    const doc = {
      models: { default: "fable-5" },
      workspaces: { path: "/x" },
      tool_approvals_enabled: true,
      providers: { claude: { auth: "cli" } },
    };
    const r = sanitizeLayer(doc, "repo-local");
    expect(r.doc).toEqual({ workspaces: { path: "/x" } });
    expect(r.warnings).toHaveLength(3);
  });

  it("preserves unknown keys at top level and inside known tables", () => {
    const r = sanitizeLayer(
      { brand_new: true, scripts: { run: "x", new_knob: "y" } },
      "repo",
    );
    expect(r.doc.brand_new).toBe(true);
    expect((r.doc.scripts as Record<string, unknown>).new_knob).toBe("y");
    expect(r.warnings).toEqual([]);
  });

  it("keeps a valid [mcp] table (stdio + http) at the user layer, drops it from repo", () => {
    const doc = {
      mcp: {
        servers: [
          {
            name: "context7",
            transport: "stdio",
            command: "npx",
            args: ["-y", "ctx7"],
          },
          {
            name: "tracker",
            transport: "http",
            url: "https://mcp.tracker.example/mcp",
          },
        ],
      },
    };
    // mcp is user-level only since the 2026-07-17 slimming — a repo file's
    // [mcp] table is ignored wholesale with a warning.
    const user = sanitizeLayer(doc, "user");
    expect(user.doc).toEqual(doc);
    expect(user.warnings).toEqual([]);
    const repo = sanitizeLayer(doc, "repo");
    expect(repo.doc).toEqual({});
    expect(repo.warnings).toHaveLength(1);
    expect(repo.warnings[0]).toContain("mcp");
  });

  it("drops one invalid mcp server, keeps siblings + order, one warning each", () => {
    const r = sanitizeLayer(
      {
        mcp: {
          servers: [
            { name: "ok1", transport: "stdio", command: "a" },
            { name: "bad", transport: "stdio" }, // missing command
            { transport: "http", url: "https://x/mcp" }, // missing name
            { name: "ok2", transport: "http", url: "https://y/mcp" },
          ],
        },
      },
      "user",
    );
    const servers = (r.doc.mcp as { servers: Array<{ name: string }> }).servers;
    expect(servers.map((s) => s.name)).toEqual(["ok1", "ok2"]);
    expect(r.warnings).toHaveLength(2);
  });

  it("warns when [mcp] is not a table or mcp.servers is not an array", () => {
    expect(sanitizeLayer({ mcp: "nope" }, "user").warnings).toHaveLength(1);
    expect(sanitizeLayer({ mcp: "nope" }, "user").doc.mcp).toBeUndefined();
    const r = sanitizeLayer({ mcp: { servers: { not: "an array" } } }, "user");
    expect(r.warnings).toHaveLength(1);
    expect((r.doc.mcp as Record<string, unknown>).servers).toBeUndefined();
  });

  it("preserves unknown keys under [mcp] verbatim (forward-compat)", () => {
    const r = sanitizeLayer({ mcp: { future_knob: 7, servers: [] } }, "user");
    expect((r.doc.mcp as Record<string, unknown>).future_knob).toBe(7);
    expect(r.warnings).toEqual([]);
  });
});
