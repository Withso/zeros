import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { lexer, type Tokens } from "marked";
import { describe, expect, it } from "vitest";

function sourceRules(file: string) {
  const rules: { key: string; source: string }[] = [];
  let section = "";
  const add = (source: string) => {
    const text = source.replace(/\s+/g, " ").trim();
    if (!text || /^\*\*[^*]+\*\*$/.test(text)) return;
    rules.push({ source: text, key: `${file}:${createHash("sha256")
      .update(`${section}\n${text}`).digest("hex").slice(0, 16)}` });
  };
  const list = (token: Tokens.List) => {
    for (const item of token.items) {
      add(item.tokens.filter(child => child.type !== "list").map(child => child.raw).join(" "));
      for (const child of item.tokens) if (child.type === "list") list(child as Tokens.List);
    }
  };
  for (const token of lexer(readFileSync(file, "utf8"))) {
    if (token.type === "heading") section = token.text;
    else if (token.type === "list") list(token as Tokens.List);
    else if (token.type === "paragraph") add(token.raw);
    else if (token.type === "table")
      for (const row of (token as Tokens.Table).rows) add(row.map(cell => cell.text).join(" | "));
  }
  return rules;
}

function tables() {
  return lexer(readFileSync("agents/zstack/enforcement.md", "utf8"))
    .filter(token => token.type === "table") as Tokens.Table[];
}

describe("zstack rule enforcers", () => {
  it("maps every source rule once and invalidates rows when their source changes", () => {
    const expected = ["AGENTS.md", "RULES.md"].flatMap(sourceRules);
    const rows = tables().filter(table => table.header[0].text === "Rule").flatMap(table => table.rows);
    const keys = rows.map(row => /<!-- rule:((?:AGENTS|RULES)\.md:[a-f0-9]{16}) -->/.exec(row[0].text)?.[1]);
    const missing = expected.filter(rule => !keys.includes(rule.key));
    expect(missing, "Add or re-review mappings for these source rules").toEqual([]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.filter(Boolean).sort()).toEqual(expected.map(rule => rule.key).sort());
    expect(rows.length).toBe(expected.length);
  });

  it("resolves every named enforcer to a real file, package script or CI job", () => {
    const all = tables();
    const registry = all.filter(table => table.header[0].text === "Enforcer").flatMap(table => table.rows);
    const names = registry.map(row => row[0].text.replaceAll("`", ""));
    expect(new Set(names).size).toBe(names.length);
    expect(registry.length).toBeGreaterThan(0);
    const used = new Set<string>();
    for (const row of all.filter(table => table.header[0].text === "Rule").flatMap(table => table.rows)) {
      const references = [...row[1].text.matchAll(/`([^`]+)`/g)].map(match => match[1]);
      expect(row[2]?.text.trim().length).toBeGreaterThan(0);
      if (!references.length) expect(row[1].text).toBe("judgment only");
      for (const name of references) { expect(names, row[0].text).toContain(name); used.add(name); }
    }
    expect([...used].sort()).toEqual([...names].sort());
    for (const row of registry) {
      const [name, kind, location] = row.map(cell => cell.text.replaceAll("`", ""));
      expect(["test", "lint", "script", "CI lane"], name).toContain(kind);
      const [file, member, extra] = location.split("#");
      expect(extra, name).toBeUndefined();
      expect(file, name).not.toMatch(/^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/);
      const source = readFileSync(file, "utf8");
      if (kind === "test") expect(file, name).toMatch(/\.test\.[cm]?[jt]sx?$/);
      if (kind === "CI lane") {
        expect(member, name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(source.split("\njobs:\n")[1]?.split(/\r?\n/), name).toContain(`  ${member}:`);
      } else if (member) {
        expect(kind, name).toBe("script");
        expect(JSON.parse(source).scripts?.[member], name).toEqual(expect.any(String));
      }
    }
  });
});
