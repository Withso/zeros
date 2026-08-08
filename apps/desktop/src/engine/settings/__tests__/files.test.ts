import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySettingsPatch,
  readSettingsFile,
  repoLocalSettingsPath,
  repoSettingsPath,
  updateSettingsFile,
  userSettingsPath,
  writeSettingsFile,
} from "../files";
import { SCHEMA_URL_REPO } from "../schema";
import { opSettingsWriteRaw } from "../ops";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "zeros-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("paths", () => {
  it("repo files live under <repo>/.zeros/", () => {
    expect(repoSettingsPath("/repo")).toBe(
      path.join("/repo", ".zeros", "settings.toml"),
    );
    expect(repoLocalSettingsPath("/repo")).toBe(
      path.join("/repo", ".zeros", "settings.local.toml"),
    );
  });

  it("user settings dir honors ZEROS_USER_SETTINGS_DIR", () => {
    const prev = process.env.ZEROS_USER_SETTINGS_DIR;
    process.env.ZEROS_USER_SETTINGS_DIR = dir;
    try {
      expect(userSettingsPath()).toBe(path.join(dir, "settings.toml"));
    } finally {
      if (prev === undefined) delete process.env.ZEROS_USER_SETTINGS_DIR;
      else process.env.ZEROS_USER_SETTINGS_DIR = prev;
    }
  });
});

describe("readSettingsFile", () => {
  it("missing file → empty doc, exists:false, no error", () => {
    const r = readSettingsFile(path.join(dir, "nope.toml"));
    expect(r).toEqual({ doc: {}, exists: false });
  });

  it("malformed file → empty doc, exists:true, error set", () => {
    const file = path.join(dir, "bad.toml");
    writeFileSync(file, "[scripts\nrun = oops", "utf8");
    const r = readSettingsFile(file);
    expect(r.exists).toBe(true);
    expect(r.doc).toEqual({});
    expect(r.error).toBeTruthy();
  });

  it("parses a real document with tables and arrays", () => {
    const file = path.join(dir, "ok.toml");
    writeFileSync(
      file,
      `env_files = [".env.agent"]\n[scripts]\nrun = "pnpm dev"\n[env]\nA = "1"\n`,
      "utf8",
    );
    const r = readSettingsFile(file);
    expect(r.error).toBeUndefined();
    expect(r.doc).toEqual({
      env_files: [".env.agent"],
      scripts: { run: "pnpm dev" },
      env: { A: "1" },
    });
  });
});

describe("writeSettingsFile", () => {
  it("round-trips a nested document and creates parent dirs", () => {
    const file = path.join(dir, "deep", "nested", "settings.toml");
    const doc = {
      scripts: { setup: "pnpm install", run_mode: "concurrent" },
      env: { NODE_OPTIONS: "--max-old-space-size=8192" },
      env_files: [".env.agent"],
      providers: { claude: { auth: "cli" } },
    };
    writeSettingsFile(file, doc, { schemaUrl: null });
    expect(readSettingsFile(file).doc).toEqual(doc);
  });

  it("round-trips bounded per-model configuration records", () => {
    const file = path.join(dir, "settings.toml");
    const preferences = [
      {
        agent: "codex",
        model: "gpt-5.6-sol",
        effort: "max",
        fast: true,
      },
      {
        agent: "claude",
        model: "claude-opus-5[1m]",
        effort: "high",
        fast: false,
      },
    ];

    writeSettingsFile(
      file,
      { models: { model_preferences: preferences } },
      { schemaUrl: null },
    );

    expect(readSettingsFile(file).doc).toEqual({
      models: { model_preferences: preferences },
    });
  });

  it("round-trips and authoritatively clears per-agent permission records", () => {
    const file = path.join(dir, "settings.toml");
    const preferences = [
      { agent: "claude", mode: "auto" },
      { agent: "codex", mode: "auto-edit" },
    ];

    updateSettingsFile(
      file,
      { models: { permission_preferences: preferences } },
      { schemaUrl: null },
    );
    expect(readSettingsFile(file).doc).toEqual({
      models: { permission_preferences: preferences },
    });

    updateSettingsFile(
      file,
      { models: { permission_preferences: [] } },
      { schemaUrl: null },
    );
    expect(readSettingsFile(file).doc).toEqual({
      models: { permission_preferences: [] },
    });
  });

  it("replaces per-model records with an authoritative empty array", () => {
    const file = path.join(dir, "settings.toml");
    updateSettingsFile(
      file,
      {
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
      },
      { schemaUrl: null },
    );

    updateSettingsFile(
      file,
      { models: { model_preferences: [] } },
      { schemaUrl: null },
    );

    expect(readSettingsFile(file).doc).toEqual({
      models: { model_preferences: [] },
    });
  });

  it("injects $schema as the first key when missing, preserves an existing one", () => {
    const file = path.join(dir, "settings.toml");
    writeSettingsFile(
      file,
      { scripts: { run: "x" } },
      { schemaUrl: SCHEMA_URL_REPO },
    );
    const text = readFileSync(file, "utf8");
    expect(text.startsWith(`"$schema" = "${SCHEMA_URL_REPO}"`)).toBe(true);

    writeSettingsFile(
      file,
      { $schema: "https://example.com/custom.json" },
      { schemaUrl: SCHEMA_URL_REPO },
    );
    expect(readSettingsFile(file).doc.$schema).toBe(
      "https://example.com/custom.json",
    );
  });

  it("strips undefined values instead of throwing", () => {
    const file = path.join(dir, "settings.toml");
    writeSettingsFile(
      file,
      { scripts: { run: "x", archive: undefined } } as never,
      {
        schemaUrl: null,
      },
    );
    expect(readSettingsFile(file).doc).toEqual({ scripts: { run: "x" } });
  });
});

describe("applySettingsPatch", () => {
  it("deep-merges tables, replaces scalars and arrays, null deletes", () => {
    const doc = {
      scripts: { setup: "a", run: "b" },
      env: { A: "1", B: "2" },
      env_files: [".env"],
    };
    const next = applySettingsPatch(doc, {
      scripts: { run: "c", archive: null },
      env: { B: null, C: "3" },
      env_files: [".env.agent"],
    } as never);
    expect(next).toEqual({
      scripts: { setup: "a", run: "c" },
      env: { A: "1", C: "3" },
      env_files: [".env.agent"],
    });
    expect(doc.env).toEqual({ A: "1", B: "2" }); // input untouched
  });

  it("removes a table that becomes empty after deletes", () => {
    const next = applySettingsPatch({ env: { A: "1" } }, {
      env: { A: null },
    } as never);
    expect(next).toEqual({});
  });
});

describe("updateSettingsFile", () => {
  it("read-modify-write preserves unknown keys", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(
      file,
      `future_key = "from-a-newer-zeros"\n[future_table]\nknob = 1\n[scripts]\nrun = "old"\n`,
      "utf8",
    );
    const next = updateSettingsFile(
      file,
      { scripts: { run: "new" } },
      { schemaUrl: null },
    );
    expect(next.future_key).toBe("from-a-newer-zeros");
    expect(next.future_table).toEqual({ knob: 1 });
    expect(next.scripts).toEqual({ run: "new" });
    expect(readSettingsFile(file).doc).toEqual(next);
  });

  it("preserves unknown nested model keys when patching a known sibling", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(
      file,
      [
        "[models.claude_code]",
        'default = "claude-sonnet"',
        'review_effort_level = "future-tier"',
        "",
      ].join("\n"),
      "utf8",
    );

    updateSettingsFile(
      file,
      { models: { claude_code: { default: "claude-opus" } } } as never,
      { schemaUrl: null },
    );

    const claude = (
      readSettingsFile(file).doc.models as {
        claude_code: Record<string, unknown>;
      }
    ).claude_code;
    expect(claude.default).toBe("claude-opus");
    expect(claude.review_effort_level).toBe("future-tier");
  });

  it("creates the file (with $schema) when it doesn't exist", () => {
    const file = path.join(dir, ".zeros", "settings.toml");
    updateSettingsFile(
      file,
      { git: { base_branch: "main" } },
      { schemaUrl: SCHEMA_URL_REPO },
    );
    const r = readSettingsFile(file);
    expect(r.doc.$schema).toBe(SCHEMA_URL_REPO);
    expect(r.doc.git).toEqual({ base_branch: "main" });
  });

  it("refuses to clobber a malformed file", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(file, "this is [not toml", "utf8");
    expect(() => updateSettingsFile(file, { scripts: { run: "x" } })).toThrow(
      /malformed/,
    );
    expect(readFileSync(file, "utf8")).toBe("this is [not toml"); // untouched
  });

  it("preserves comments and layout when editing an existing value", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(
      file,
      [
        "# top-of-file note",
        "",
        "[scripts]",
        'run = "old"  # inline note',
        "",
        "[env]",
        "# keep me",
        'FOO = "1"',
        "",
      ].join("\n"),
      "utf8",
    );
    updateSettingsFile(file, { scripts: { run: "new" } }, { schemaUrl: null });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# top-of-file note");
    expect(text).toContain("# inline note");
    expect(text).toContain("# keep me");
    expect(text).toContain('run = "new"');
    const r = readSettingsFile(file);
    expect(r.doc.scripts).toEqual({ run: "new" });
    expect(r.doc.env).toEqual({ FOO: "1" });
  });

  it("preserves surrounding comments when deleting a key (null patch)", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(
      file,
      ["# header", "[env]", "# A note", 'A = "1"', 'B = "2"', ""].join("\n"),
      "utf8",
    );
    updateSettingsFile(file, { env: { A: null } } as never, {
      schemaUrl: null,
    });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# header");
    expect(text).not.toContain('A = "1"'); // deleted
    expect(text).toContain('B = "2"'); // sibling kept
    expect(readSettingsFile(file).doc.env).toEqual({ B: "2" });
  });

  it("round-trips an mcp.servers array-of-tables (stdio + http) and replaces it on re-patch", () => {
    const file = path.join(dir, "settings.toml");
    const servers = [
      {
        name: "context7",
        transport: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
      {
        name: "tracker",
        transport: "http",
        url: "https://mcp.tracker.example/mcp",
      },
    ];
    updateSettingsFile(file, { mcp: { servers } }, { schemaUrl: null });
    // Serialized as a real array-of-tables that parses straight back.
    expect(
      (readSettingsFile(file).doc.mcp as { servers: unknown[] }).servers,
    ).toEqual(servers);
    // Arrays replace whole — re-patching with a different list swaps it cleanly.
    const replaced = [
      { name: "figma", transport: "http", url: "https://figma/mcp" },
    ];
    updateSettingsFile(
      file,
      { mcp: { servers: replaced } },
      { schemaUrl: null },
    );
    expect(
      (readSettingsFile(file).doc.mcp as { servers: unknown[] }).servers,
    ).toEqual(replaced);
  });

  it("recovers when toml-patch silently emits invalid TOML for an inline servers array", () => {
    const file = path.join(dir, "settings.toml");
    // A hand-written / imported file with a single-line INLINE array-of-tables.
    // Reshaping the entry's key set makes @decimalturn/toml-patch drop the closing
    // brace WITHOUT throwing — the serializer must round-trip + fall back, not write
    // corrupt TOML that wedges every later write with "refusing to overwrite malformed".
    writeFileSync(
      file,
      '[mcp]\nservers = [{name="a",transport="stdio",command="x"}]\n',
      "utf8",
    );
    const replaced = [{ name: "b", transport: "http", url: "https://y" }];
    updateSettingsFile(
      file,
      { mcp: { servers: replaced } },
      { schemaUrl: null },
    );
    const read = readSettingsFile(file);
    expect(read.error).toBeUndefined();
    expect((read.doc.mcp as { servers: unknown[] }).servers).toEqual(replaced);
  });

  it("preserves comments + sibling keys when adding mcp.servers to an existing file", () => {
    const file = path.join(dir, "settings.toml");
    writeFileSync(
      file,
      ["# my config", "[env]", 'FOO = "1"  # keep', ""].join("\n"),
      "utf8",
    );
    updateSettingsFile(
      file,
      { mcp: { servers: [{ name: "a", transport: "stdio", command: "x" }] } },
      { schemaUrl: null },
    );
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# my config");
    expect(text).toContain("# keep");
    const doc = readSettingsFile(file).doc;
    expect(doc.env).toEqual({ FOO: "1" });
    expect(
      (doc.mcp as { servers: Array<{ name: string }> }).servers[0]!.name,
    ).toBe("a");
  });

  it("falls back to a full rewrite when existingText can't be patched (never throws)", () => {
    const file = path.join(dir, "settings.toml");
    expect(() =>
      writeSettingsFile(
        file,
        { scripts: { run: "ok" } },
        { schemaUrl: null, existingText: "this is ::: not toml @@@" },
      ),
    ).not.toThrow();
    expect(readSettingsFile(file).doc.scripts).toEqual({ run: "ok" });
  });
});

describe("opSettingsWriteRaw (the raw 'Edit settings.toml' editor)", () => {
  it("writes valid TOML VERBATIM — comments + layout preserved", () => {
    const text = `# my note\n[git]\nremote = "upstream"  # inline\n`;
    const r = opSettingsWriteRaw("repo", text, dir);
    expect((r.doc as { git?: { remote?: string } }).git).toEqual({
      remote: "upstream",
    });
    const onDisk = readFileSync(
      path.join(dir, ".zeros", "settings.toml"),
      "utf8",
    );
    expect(onDisk).toBe(text); // byte-for-byte
    expect(onDisk).toContain("# my note");
    expect(onDisk).toContain("# inline");
  });

  it("rejects unparseable TOML and does NOT write the file", () => {
    expect(() => opSettingsWriteRaw("repo", "this is [not valid", dir)).toThrow(
      /invalid TOML/i,
    );
    expect(() =>
      readFileSync(path.join(dir, ".zeros", "settings.toml"), "utf8"),
    ).toThrow();
  });
});
