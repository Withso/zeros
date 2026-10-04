export type MigrationPhase = "legacy" | "expand" | "contract";
export type MigrationPhaseDeclaration = {
  phase: MigrationPhase;
  contractAfter: string | null;
};
export class MigrationPhaseError extends Error {}

export function isNewerExpandMigration(
  row: { name: string; phase?: string | null },
  packagedHead: number,
): boolean {
  return (
    row.phase === "expand" &&
    /^\d{4}_[a-z0-9_]+\.sql$/.test(row.name) &&
    Number(row.name.slice(0, 4)) > packagedHead
  );
}

export function migrationPhase(
  file: string,
  sql: string,
): MigrationPhaseDeclaration {
  if (Number(file.slice(0, 4)) < 122)
    return { phase: "legacy", contractAfter: null };
  const header = /^-- zeros-migration: (expand|contract)(?:\r?\n|$)/.exec(sql);
  if (!header)
    throw new MigrationPhaseError(
      `Migration ${file} must start with -- zeros-migration: expand or contract.`,
    );
  if (header[1] === "expand") return { phase: "expand", contractAfter: null };
  const date = sql
    .split(/\r?\n/)
    .slice(1, 12)
    .map((line) => /^-- zeros-contract-after: (\d{4}-\d{2}-\d{2})$/.exec(line))
    .find((match) => match !== null)?.[1];
  const instant = date ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (
    !date ||
    !Number.isFinite(instant) ||
    new Date(instant).toISOString().slice(0, 10) !== date
  ) {
    throw new MigrationPhaseError(
      `Contract migration ${file} requires -- zeros-contract-after: <YYYY-MM-DD> with a valid UTC date.`,
    );
  }
  return { phase: "contract", contractAfter: date };
}

export function assertContractMigrationReady(
  file: string,
  declaration: MigrationPhaseDeclaration,
  now = new Date(),
): void {
  if (
    declaration.phase === "contract" &&
    now.getTime() < Date.parse(`${declaration.contractAfter}T00:00:00.000Z`)
  ) {
    throw new MigrationPhaseError(
      `Contract migration ${file} cannot run before ${declaration.contractAfter} (UTC).`,
    );
  }
}

function isExecutableBody(tokens: string[]): boolean {
  const statement = tokens.slice(tokens.lastIndexOf(";") + 1);
  const source = statement.join(" ");
  return (
    /\bDO(?: LANGUAGE [A-Z_][A-Z0-9_$]*)?(?: [EUN])?$/.test(source) ||
    ((statement.includes("FUNCTION") || statement.includes("PROCEDURE")) &&
      /\bAS(?: [EUN])?$/.test(source))
  );
}

function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < sql.length) {
    const rest = sql.slice(cursor);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", cursor + 2);
      cursor = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      let depth = 1;
      cursor += 2;
      while (cursor < sql.length && depth > 0) {
        if (sql.startsWith("/*", cursor)) {
          depth++;
          cursor += 2;
        } else if (sql.startsWith("*/", cursor)) {
          depth--;
          cursor += 2;
        } else cursor++;
      }
      continue;
    }
    const character = sql[cursor]!;
    if (character === "'" || character === '"') {
      if (character === "'" && isExecutableBody(tokens))
        throw new MigrationPhaseError(
          "Executable expand migration bodies must use dollar quoting for SQL inspection.",
        );
      const quote = character,
        escaped =
          quote === "'" &&
          /[eE]/.test(sql[cursor - 1] ?? "") &&
          !/[\w$]/.test(sql[cursor - 2] ?? "");
      cursor++;
      while (cursor < sql.length) {
        if (escaped && sql[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) {
          cursor++;
          if (sql[cursor] === quote) {
            cursor++;
            continue;
          }
          break;
        }
        cursor++;
      }
      tokens.push(quote === '"' ? "IDENTIFIER" : "VALUE");
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest)?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, cursor + dollar.length);
      if (end < 0)
        throw new MigrationPhaseError(
          "Unterminated dollar-quoted migration body.",
        );
      if (isExecutableBody(tokens)) {
        // Body statements must not inherit their declaration's token context.
        tokens.push(
          ";",
          ...sqlTokens(sql.slice(cursor + dollar.length, end)),
          ";",
        );
      } else tokens.push("VALUE");
      cursor = end + dollar.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(rest)?.[0];
    if (word) {
      tokens.push(word.toUpperCase());
      cursor += word.length;
      continue;
    }
    if (/[;,()]/.test(character)) tokens.push(character);
    cursor++;
  }
  return tokens;
}

export function expandMigrationViolations(sql: string): string[] {
  const tokens = sqlTokens(sql),
    source = tokens.join(" ");
  const violations: string[] = [];
  const forbidden = [
    ["DROP", /\bDROP\b/],
    ["RENAME", /\bRENAME\b/],
    ["TRUNCATE", /\bTRUNCATE\b/],
    ["REVOKE", /\bREVOKE\b/],
    [
      "ALTER COLUMN TYPE",
      /\bALTER (?:COLUMN |ATTRIBUTE )?[^ ;,]+ (?:SET DATA )?TYPE\b/,
    ],
    ["SET NOT NULL", /\bSET NOT NULL\b/],
    ["SET SCHEMA", /\bSET SCHEMA\b/],
    ["CREATE OR REPLACE", /\bCREATE OR REPLACE\b/],
  ] as const;
  for (const [label, pattern] of forbidden)
    if (pattern.test(source)) violations.push(label);
  let statementStart = 0;
  for (const [index, token] of tokens.entries()) {
    if (token === ";" || token === "BEGIN") {
      statementStart = index + 1;
      continue;
    }
    if (token !== "DELETE" && token !== "EXECUTE") continue;
    const prefix = tokens.slice(statementStart, index),
      // Procedural control flow may precede a DDL or GRANT statement.
      statement = prefix.slice(
        Math.max(0, prefix.lastIndexOf("CREATE"), prefix.lastIndexOf("GRANT")),
      ),
      previous = tokens[index - 1],
      next = tokens[index + 1],
      grantPrivileges =
        statement[0] === "GRANT" &&
        !statement.some((word) => word === "ON" || word === "TO") &&
        (previous === "GRANT" || previous === ",") &&
        (next === "," || next === "ON"),
      trigger = /^CREATE (?:CONSTRAINT )?TRIGGER\b/.test(statement.join(" "));
    if (
      token === "DELETE" &&
      !(
        grantPrivileges ||
        (previous === "ON" &&
          statement.includes("REFERENCES") &&
          /^(?:CASCADE|RESTRICT|SET (?:NULL|DEFAULT)|NO ACTION)\b/.test(
            tokens.slice(index + 1, index + 3).join(" "),
          )) ||
        (trigger &&
          !statement.includes("ON") &&
          (["BEFORE", "AFTER", "OR"].includes(previous ?? "") ||
            (previous === "OF" && tokens[index - 2] === "INSTEAD")) &&
          (next === "OR" || next === "ON")) ||
        (statement[0] === "CREATE" &&
          statement[1] === "POLICY" &&
          previous === "FOR" &&
          next !== "FROM")
      )
    )
      violations.push("DELETE");
    if (
      token === "EXECUTE" &&
      !grantPrivileges &&
      !(
        trigger &&
        statement.includes("ON") &&
        (next === "FUNCTION" || next === "PROCEDURE")
      )
    )
      violations.push("dynamic SQL EXECUTE");
  }
  for (const clause of source.matchAll(/\bADD (?:COLUMN )?([^;,]+)/g)) {
    if (
      /\bNOT NULL\b/.test(clause[1]!) &&
      !/(?<!SET )\bDEFAULT\b/.test(clause[1]!)
    )
      violations.push("ADD NOT NULL without a compatible DEFAULT");
  }
  return [...new Set(violations)];
}
