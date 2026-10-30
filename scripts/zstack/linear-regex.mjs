// Times every regular expression in the given files against crafted inputs at
// two sizes. A scan whose cost grows faster than its input is super-linear.
// Review of #790 found four such expressions that took seconds on 100 KB, and
// static regex analysis misses those whose slow part follows a literal prefix
// ("eyJ", "curl"), so the inputs repeat the pattern's own literal words too.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";

// Quadrupling the input quadruples a linear scan and multiplies a quadratic
// one by sixteen; the threshold sits between them with room for noise.
export const BASE_SIZE = 5_000;
const FACTOR = 4;
const GROWTH = 8;
const MIN_FLAGGED_MS = 30;
const GENERIC = [" ", "\n", "\t", "a", "a-", "aB1-", "-", "=", ":", "\"", "'", "<a", "/", "*", "`", "0", ".", "_",
  "a ", "a=", "a:", " :", "\" ", "\\", "[", "("];

/** Regular expression literals and `new RegExp("…")` calls with literal arguments. */
export function regexesIn(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const end = node.text.lastIndexOf("/");
      found.push({ file, line: line(node), source: node.text.slice(1, end), flags: node.text.slice(end + 1) });
    } else if (ts.isNewExpression(node) && node.expression.getText(source) === "RegExp" && node.arguments?.[0]
      && ts.isStringLiteral(node.arguments[0])) {
      const flags = node.arguments[1] && ts.isStringLiteral(node.arguments[1]) ? node.arguments[1].text : "";
      found.push({ file, line: line(node), source: node.arguments[0].text, flags });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const fill = (unit, size) => `${unit.repeat(Math.ceil(size / unit.length)).slice(0, size)}!`;

/** Repeating units: generic shapes plus each literal word in the pattern. */
export function attackUnits(pattern) {
  const words = pattern.replace(/\\./g, " ").replace(/\[[^\][]*\]/g, " ").match(/[A-Za-z]{2,}/g) ?? [];
  return [...new Set([...GENERIC, ...words.flatMap((word) => [word, `${word} `, `${word}-`, `${word}a`, `${word}.`])])];
}

// A separate context lets a catastrophic pattern be stopped by a timeout.
const context = vm.createContext({});
function scan(pattern, flags, input, timeout) {
  context.args = { pattern, flags: flags.includes("g") ? flags : `${flags}g`, input };
  const started = performance.now();
  try {
    vm.runInContext("new RegExp(args.pattern, args.flags)[Symbol.replace](args.input, '')", context, { timeout });
  } catch (error) {
    if (error?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return Infinity;
    throw error;
  }
  return performance.now() - started;
}

// The fastest of three base scans discounts scheduling noise on a busy host.
function grows(pattern, flags, unit, size) {
  let base = scan(pattern, flags, fill(unit, size), 2_000);
  if (base === Infinity) return { base, large: Infinity };
  for (let run = 1; run < 3; run++) base = Math.min(base, scan(pattern, flags, fill(unit, size), 2_000));
  const large = scan(pattern, flags, fill(unit, size * FACTOR), 4_000);
  return large === Infinity || (large > MIN_FLAGGED_MS && large > GROWTH * Math.max(base, 0.25)) ? { base, large } : null;
}

/** The first input shape whose global scan grows super-linearly, confirmed by a second measurement. */
export function superLinear({ source, flags }, size = BASE_SIZE) {
  for (const unit of attackUnits(source)) {
    const first = grows(source, flags, unit, size);
    if (first && grows(source, flags, unit, size)) return { unit, baseMs: Math.round(first.base), largeMs: Math.round(first.large) };
  }
  return null;
}

export function findSuperLinear(files) {
  return files.flatMap((file) => regexesIn(readFileSync(file, "utf8"), file))
    .map((regex) => ({ ...regex, growth: superLinear(regex) }))
    .filter((regex) => regex.growth);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const flagged = findSuperLinear(process.argv.slice(2));
  for (const { file, line, source, flags, growth } of flagged)
    console.log(`${file}:${line} /${source}/${flags} grows on ${JSON.stringify(growth.unit)}: ${growth.baseMs} ms → ${growth.largeMs} ms at ${FACTOR}x`);
  process.exitCode = flagged.length ? 1 : 0;
}
