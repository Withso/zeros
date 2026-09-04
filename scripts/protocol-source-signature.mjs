import ts from "typescript";

const printer = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: true,
});

/**
 * Return a formatting- and comment-insensitive representation of a TypeScript
 * wire-contract source file. Printing the parsed syntax tree is deliberate:
 * scanning raw text cannot safely distinguish backticks in comments from
 * template-literal boundaries without parser context.
 */
export function protocolSourceSignature(source) {
  const normalized = source.replaceAll("@zeros/core", "@zeros/protocol");
  const sourceFile = ts.createSourceFile(
    "wire-schema.ts",
    normalized,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return printer.printFile(sourceFile);
}

/** Read a decimal integer from one real exported const declaration. */
export function exportedIntegerConstant(source, name) {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) return null;
  const normalized = protocolSourceSignature(source);
  return (
    normalized.match(
      new RegExp(
        `^export const ${name}\\s*=\\s*(\\d+)\\s*(?:as\\s+const\\s*)?;`,
        "mu",
      ),
    )?.[1] ?? null
  );
}
