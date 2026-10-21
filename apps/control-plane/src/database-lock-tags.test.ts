import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";
import { ADVISORY_LOCK_PURPOSES } from "./database-timing.js";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(file);
    return entry.name.endsWith(".ts") && !/test|fixture/.test(entry.name) ? [file] : [];
  });
}

it("gives every application/operator advisory lock a static SQLCommenter purpose", () => {
  const missing: string[] = [];
  let statements = 0;
  for (const file of sources(path.resolve("src"))) {
    const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      const sql = ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map(span => "?" + span.literal.text).join("") : undefined;
      if (sql && /\bpg_(?:try_)?advisory_(?:xact_)?(?:lock|unlock)(?:_shared)?\s*\(/.test(sql)) {
        statements++;
        const tags = [...sql.matchAll(/\/\*\s*lock_purpose='([a-z][a-z0-9-]{1,63})'\s*\*\//g)];
        if (tags.length !== 1 || !ADVISORY_LOCK_PURPOSES.some(purpose => purpose === tags[0]![1]))
          missing.push(`${path.relative(process.cwd(), file)}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  expect(statements).toBeGreaterThanOrEqual(22);
  expect(missing).toEqual([]);
});
