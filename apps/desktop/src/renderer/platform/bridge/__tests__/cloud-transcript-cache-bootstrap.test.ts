import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it } from "vitest";

it("keeps the bridge and injected checkpoint helper free of eager workspace-store imports for Design bootstrap", () => {
  // workspace-store → projects/catalog → team-sync → use-bridge must not
  // acquire a return edge while the synchronous Local boot state is loading.
  for (const file of ["use-bridge.tsx", "cloud-transcript-checkpoints.ts"]) {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imports = source.statements.filter(ts.isImportDeclaration).filter(statement => {
      const clause = statement.importClause;
      return !clause?.isTypeOnly && (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings) ||
        clause.name || clause.namedBindings.elements.some(element => !element.isTypeOnly));
    }).map(statement => (statement.moduleSpecifier as ts.StringLiteral).text);
    expect(imports.filter(dependency => /(?:^|\/)state\/(?:workspace-store|store|projects-store|cloud-workspace-lifecycle)$/u.test(dependency)), file).toEqual([]);
  }
});
