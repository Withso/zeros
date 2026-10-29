import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bannerLines, compareSource, density, verifyCommentsOnly } from "../zstack/comments.mjs";

const codes = (problems: Array<{ code: string }>) => problems.map((problem) => problem.code);

describe("comments-only comparison", () => {
  it("accepts removed and shortened comments and layout changes", () => {
    const before = "// Narration.\n/** Long\n * essay. */\nexport function f(a: number) {\n  return a + 1; // trailing\n}\n";
    const after = "/** Why. */\nexport function f(a: number) { return a + 1; }\n";
    expect(compareSource("x.ts", before, after)).toEqual([]);
  });

  it("refuses a code change hidden beside a comment edit", () => {
    expect(codes(compareSource("x.ts", "// a\nconst x = 1;\n", "const x = 2;\n"))).toEqual(["zstack_comments_code_changed"]);
  });

  it("refuses a newline change that alters automatic semicolon insertion", () => {
    expect(codes(compareSource("x.ts", "function f() {\n  return /* c */\n  1;\n}\n", "function f() {\n  return 1;\n}\n")))
      .toEqual(["zstack_comments_code_changed"]);
  });

  it("accepts removing a JSX comment between elements", () => {
    const before = "const v = (\n  <div>\n    {/* note */}\n    <span />\n  </div>\n);\n";
    const after = "const v = (\n  <div>\n    <span />\n  </div>\n);\n";
    expect(compareSource("x.tsx", before, after)).toEqual([]);
  });

  it("refuses a JSX comment removal that joins rendered text", () => {
    const before = "const v = (\n  <p>\n    one\n    {/* note */}\n    two\n  </p>\n);\n";
    const after = "const v = (\n  <p>\n    one\n    two\n  </p>\n);\n";
    expect(codes(compareSource("x.tsx", before, after))).toEqual(["zstack_comments_code_changed"]);
  });

  it("accepts removing an inline JSX comment when the rendered text is unchanged", () => {
    expect(compareSource("x.tsx", "const v = <p>one {/* c */} two</p>;\n", "const v = <p>one  two</p>;\n")).toEqual([]);
  });

  it.each([
    ["// eslint-disable-next-line no-console -- the CLI prints\n", "x.ts"],
    ["// @ts-expect-error the untyped module\n", "x.ts"],
    ["/* Copyright 2026 Example */\n", "x.ts"],
    ["/** @type {number} */\n", "x.mjs"],
  ])("refuses removing the protected comment %j", (comment, path) => {
    expect(codes(compareSource(path, `${comment}const x = 1;\n`, "const x = 1;\n"))).toEqual(["zstack_comments_protected_comment"]);
  });

  it("allows removing JSDoc type tags from TypeScript", () => {
    expect(compareSource("x.ts", "/** @param {number} a */\nfunction f(a: number) {}\n", "function f(a: number) {}\n")).toEqual([]);
  });

  it("refuses a changed shebang", () => {
    expect(codes(compareSource("x.mjs", "#!/usr/bin/env node\nconst x = 1;\n", "#!/usr/bin/env bun\nconst x = 1;\n")))
      .toEqual(["zstack_comments_protected_comment"]);
  });

  it("counts comment-only lines separately from code", () => {
    expect(density("x.ts", "// one\n// two\nconst x = 1; // same line\n")).toMatchObject({ comments: 3, commentLines: 2, codeLines: 1 });
  });
});

describe("comments-only verification of a Git range", () => {
  const repositories: string[] = [];
  afterEach(() => { for (const path of repositories.splice(0)) rmSync(path, { recursive: true, force: true }); });

  const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const repository = (files: Record<string, string>) => {
    const root = mkdtempSync(join(tmpdir(), "zstack-comments-"));
    repositories.push(root);
    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, env: environment() }).toString().trim();
    run("init", "-q", "-b", "main");
    run("config", "user.email", "fixture@example.invalid");
    run("config", "user.name", "Fixture");
    const write = (entries: Record<string, string>) => {
      for (const [path, text] of Object.entries(entries)) {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      }
    };
    write(files);
    run("add", "-A");
    run("commit", "-q", "-m", "base");
    const base = run("rev-parse", "HEAD");
    const commit = (entries: Record<string, string>) => { write(entries); run("add", "-A"); run("commit", "-q", "-m", "change"); return run("rev-parse", "HEAD"); };
    return { root, base, run, write, commit };
  };

  it("accepts a commit that only removes comments", () => {
    const repo = repository({ "src/a.ts": "// narration\nexport const a = 1;\n" });
    const head = repo.commit({ "src/a.ts": "export const a = 1;\n" });
    expect(verifyCommentsOnly(repo.root, { base: repo.base, head }).problems).toEqual([]);
  });

  it("refuses protected paths, generated files, new files and other file types", () => {
    const repo = repository({
      "apps/control-plane/migrations/0001_init.sql": "-- zeros-migration: expand\nSELECT 1;\n",
      "src/generated-client.ts": "// GENERATED CODE! DO NOT MODIFY BY HAND!\n// note\nexport const b = 1;\n",
      "styles/app.css": "/* note */\na {}\n",
    });
    const head = repo.commit({
      "apps/control-plane/migrations/0001_init.sql": "SELECT 1;\n",
      "src/generated-client.ts": "// GENERATED CODE! DO NOT MODIFY BY HAND!\nexport const b = 1;\n",
      "styles/app.css": "a {}\n",
      "src/new.ts": "export const c = 1;\n",
    });
    expect(codes(verifyCommentsOnly(repo.root, { base: repo.base, head }).problems).sort()).toEqual([
      "zstack_comments_file_added_or_removed",
      "zstack_comments_protected_path",
      "zstack_comments_protected_path",
      "zstack_comments_unsupported_file",
    ]);
  });

  it("refuses a mode change", () => {
    const repo = repository({ "scripts/tool.mjs": "// note\nexport const a = 1;\n" });
    chmodSync(join(repo.root, "scripts/tool.mjs"), 0o755);
    const head = repo.commit({ "scripts/tool.mjs": "export const a = 1;\n" });
    expect(codes(verifyCommentsOnly(repo.root, { base: repo.base, head }).problems)).toEqual(["zstack_comments_mode_changed"]);
  });

  it("compares the working tree, including untracked files, when no head is given", () => {
    const repo = repository({ "src/a.ts": "// narration\nexport const a = 1;\n" });
    repo.write({ "src/a.ts": "export const a = 1;\n" });
    expect(verifyCommentsOnly(repo.root, { base: repo.base }).problems).toEqual([]);
    repo.write({ "src/b.ts": "export const b = 2;\n" });
    expect(codes(verifyCommentsOnly(repo.root, { base: repo.base }).problems)).toEqual(["zstack_comments_file_added_or_removed"]);
  });
});

describe("comment debt", () => {
  it("never adds divider comments beyond the recorded count", () => {
    const ledger = JSON.parse(readFileSync(join(process.cwd(), "agents/zstack/comment-debt.json"), "utf8"));
    expect(bannerLines(process.cwd())).toBeLessThanOrEqual(ledger.bannerLines);
  });
});
