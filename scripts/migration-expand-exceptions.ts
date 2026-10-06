import { createHash } from "node:crypto";

const filename = "0136_cloud_runtime_transfers.sql";
const exact: Readonly<Record<string, readonly string[]>> = {
  "widen-check": [3, 4, 5].map(n =>
    `ALTER TABLE cloud_workspace_generation_transitions DROP CONSTRAINT cloud_workspace_generation_transitions_check${n};`),
  "nullable-enrollment": ["setup_run_id", "setup_execution_fence", "registration_grant_id"].map(column =>
    `ALTER TABLE cloud_workspace_engine_instances ALTER COLUMN ${column} DROP NOT NULL;`),
  "enrollment-trigger": ["cloud_engine_runtime_binding", "cloud_engine_current_setup_fence"].map(trigger =>
    `DROP TRIGGER ${trigger} ON cloud_workspace_engine_instances;`),
};
// Exact reviewed function body, including quoted SQL. Changing its semantics or
// even formatting requires updating this review pin and compatibility evidence.
const authorityDigest = "797f837c345244da5af77d503614c9ddf3abb03048998a0081b98a3c2512ab30";

/** Split only at top-level SQL semicolons. Dollar bodies, nested comments and
 * quoted values remain intact; an annotation inside a function cannot exempt
 * a nested destructive statement. The ordinary guard still inspects all body
 * statements in every segment that was not explicitly exempted. */
function statements(sql: string): { text: string; header: string }[] {
  const result: { text: string; header: string }[] = [];
  let start = 0, code = -1, i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i]!)) { i++; continue; }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i + 2);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error("Unterminated migration comment");
      continue;
    }
    if (code < 0) code = i;
    const quote = sql[i];
    if (quote === "'" || quote === '"') {
      const escaped = quote === "'" && /[eE]/.test(sql[i - 1] ?? "") && !/[\w$]/.test(sql[i - 2] ?? "");
      i++;
      let closed = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") { i += 2; continue; }
        if (sql[i++] === quote) {
          if (sql[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new Error("Unterminated migration quote");
      continue;
    }
    const dollar = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error("Unterminated migration body");
      i = end + dollar.length; continue;
    }
    if (sql[i++] === ";") {
      result.push({ header: sql.slice(start, code), text: sql.slice(code, i) });
      start = i; code = -1;
    }
  }
  if (code >= 0) result.push({ header: sql.slice(start, code), text: sql.slice(code) });
  return result;
}

export function applyReviewedExpandExceptions(file: string, sql: string): string {
  if (!sql.includes("zeros-expand-exception:")) return sql;
  if (file !== filename) throw new Error("Expand exceptions are reviewed only for 0136_cloud_runtime_transfers.sql");
  let accepted = 0;
  const output = statements(sql).map(({ header, text }) => {
    const annotations = [...header.matchAll(/^-- zeros-expand-exception: ([a-z-]+) (\S[^\r\n]{15,})$/gm)];
    if (!annotations.length) return header + text;
    if (annotations.length !== 1) throw new Error("An expand exception must annotate exactly one statement");
    const rule = annotations[0]![1]!;
    const statement = text.replace(/\r\n/g, "\n").trim();
    const allowed = exact[rule]?.includes(statement) || (rule === "allocation-authority" &&
      createHash("sha256").update(statement).digest("hex") === authorityDigest);
    if (!allowed) throw new Error("Expand exception does not match its exact reviewed statement");
    accepted++;
    return "\n";
  }).join("\n");
  if (accepted !== (sql.match(/zeros-expand-exception:/g)?.length ?? 0))
    throw new Error("Expand exception must be a complete annotation before a top-level statement");
  return output;
}
