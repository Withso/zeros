#!/usr/bin/env node
/**
 * Pass 2 — strip orphan selector remnants introduced by the first
 * dead-rule pass.
 *
 * Two cleanups per file:
 *
 *   A) Orphan `${S}` lines — a line that is just the scope
 *      interpolation (`${S}` with optional trailing whitespace) and
 *      is NOT followed on the same line by a selector. Merges runs.
 *
 *   B) Dangling selector heads — a line like `${S} .foo,` whose
 *      immediately-following non-blank line is a blank or a comment,
 *      not a rule body (i.e. no `{` terminator before a blank line).
 *      These were left behind when a grouped-selector rule was fully
 *      dropped but we kept one selector by accident.
 *
 * Both cleanups operate on a line array and are line-local (don't
 * touch balanced `{ ... }` blocks).
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src");
const TARGETS = [
  "zeros/engine/zeros-styles.ts",
  "zeros/engine/styles/canvas.ts",
  "zeros/engine/styles/command-palette.ts",
  "zeros/engine/styles/panels.ts",
  "zeros/engine/styles/settings.ts",
  "zeros/engine/styles/style-panel.ts",
  "zeros/engine/styles/toolbar.ts",
].map((p) => path.join(ROOT, p));

function isOrphanScopeLine(line) {
  // matches `${S}` OR `$ {S}` (space variant that slipped in during
  // the first pass), with optional surrounding whitespace.
  return /^\s*\$\s*\{S\}\s*$/.test(line);
}

function endsWithComma(line) {
  return /,\s*(\/\*.*?\*\/)?\s*$/.test(line);
}

function isSelectorOrphan(line) {
  // A line like `${S} .foo,` with NO rule-body `{` on it and ending
  // with `,`. We must ignore `{` inside `${...}` template
  // interpolations when checking for a rule-body brace.
  const stripped = line.replace(/\$\{[^}]*\}/g, "");
  return (
    endsWithComma(line) &&
    !stripped.includes("{") &&
    /\$\{S\}/.test(line)
  );
}

function cleanup(src) {
  const lines = src.split("\n");
  const out = [];
  let orphansDropped = 0;
  let danglingDropped = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // A) collapse orphan ${S} lines. If this line is orphan, drop it
    // entirely. No compensation — they contribute zero CSS semantics.
    if (isOrphanScopeLine(line)) {
      orphansDropped++;
      continue;
    }

    // B) dangling `${S} .foo,` — check whether the NEXT non-blank
    // non-comment non-orphan line begins with an alphanumeric
    // selector character (`.` / `$` / `@`) that continues the group
    // OR contains a `{` soon.
    if (isSelectorOrphan(line)) {
      // Look ahead for the next meaningful line.  A section comment
      // `/* ── Foo ── */` or a blank line BREAKS the group — this
      // means the trailing comma is a true orphan, not a continuation.
      let j = i + 1;
      let hasContinuation = false;
      while (j < lines.length) {
        const peek = lines[j];
        if (peek.trim() === "") break; // blank line = group ended
        if (isOrphanScopeLine(peek)) { j++; continue; }
        if (/^\s*\/\*/.test(peek)) break; // section comment = group ended
        // Continuation requires a `{` on this line (rule body starts)
        // OR another comma-ending selector line.
        if (peek.includes("{") || endsWithComma(peek)) hasContinuation = true;
        break;
      }
      if (!hasContinuation) {
        danglingDropped++;
        continue;
      }
    }

    out.push(line);
  }

  // Collapse runs of 3+ consecutive blank lines down to a single blank.
  const collapsed = [];
  let blankRun = 0;
  for (const ln of out) {
    if (ln.trim() === "") {
      blankRun++;
      if (blankRun <= 1) collapsed.push(ln);
    } else {
      blankRun = 0;
      collapsed.push(ln);
    }
  }

  return {
    text: collapsed.join("\n"),
    orphansDropped,
    danglingDropped,
  };
}

let totalOrphans = 0;
let totalDangling = 0;
let totalSaved = 0;
for (const f of TARGETS) {
  if (!fs.existsSync(f)) continue;
  const before = fs.readFileSync(f, "utf8");
  const { text, orphansDropped, danglingDropped } = cleanup(before);
  if (text === before) {
    console.log(`  = ${path.relative(process.cwd(), f)}: clean`);
    continue;
  }
  fs.writeFileSync(f, text);
  totalOrphans += orphansDropped;
  totalDangling += danglingDropped;
  totalSaved += before.length - text.length;
  console.log(
    `  ✓ ${path.relative(process.cwd(), f)}: removed ${orphansDropped} orphan \${S}, ${danglingDropped} dangling selectors — ${
      before.length - text.length
    } bytes saved`,
  );
}

console.log(
  `\nTotal — removed ${totalOrphans} orphan scope lines, ${totalDangling} dangling selectors, saved ${totalSaved} bytes.`,
);
