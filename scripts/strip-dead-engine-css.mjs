#!/usr/bin/env node
/**
 * Strip dead engine CSS rules.
 *
 * Approach (pragmatic, line-oriented — runtime CSS-in-JS template
 * literal, not a real AST):
 *
 *   1. Ask `find-dead-engine-css.mjs` which classes are dead.
 *   2. For each engine CSS file, parse rule blocks (selector
 *      line(s) followed by `{ ... }`).
 *   3. A rule block is dropped if EVERY class token mentioned in
 *      its selector list is in the dead set.
 *   4. A grouped block where only some selectors are dead has the
 *      dead selectors stripped, keeping the rest.
 *   5. Orphan `/* ── Section Name ── *\/` comment lines that no
 *      longer precede any rule are left alone (harmless).
 *
 * Only touches `${S} .zeros-<name>` class rules. Element / pseudo
 * selectors and keyframes are left alone unless purely composed
 * of dead class names.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(process.cwd(), "src");

// ── 1. Get dead-class set from the scanner ─────────────
function deadSetFromScanner() {
  const out = execFileSync(
    process.execPath,
    [path.resolve("scripts/find-dead-engine-css.mjs")],
    { encoding: "utf8", cwd: process.cwd() },
  );
  const set = new Set();
  for (const line of out.split("\n")) {
    const m = line.match(/^\s{4}\.(zeros-[a-zA-Z0-9_-]+)\s*$/);
    if (m) set.add(m[1]);
  }
  return set;
}

// ── 2. Parse a CSS-in-JS string into a sequence of tokens:
//     { kind: "text" | "rule", content, selector? } ────
function parseBlocks(src) {
  const out = [];
  let i = 0;
  const n = src.length;

  function pushText(s) {
    if (!s) return;
    if (out.length && out[out.length - 1].kind === "text") {
      out[out.length - 1].content += s;
    } else {
      out.push({ kind: "text", content: s });
    }
  }

  // Walk characters, carving out rule blocks. We treat `{ ... }`
  // as a rule when the char stream just before a `{` is a selector
  // line (non-empty, not inside a comment, not a keyframe body).
  while (i < n) {
    // Skip and preserve comments and strings opaquely
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) {
        pushText(src.slice(i));
        return out;
      }
      pushText(src.slice(i, end + 2));
      i = end + 2;
      continue;
    }

    // Look ahead for the next `{`. Text between current `i` and
    // the `{` (trimmed of trailing newlines) is the selector line(s).
    const brace = src.indexOf("{", i);
    if (brace === -1) {
      pushText(src.slice(i));
      return out;
    }

    // The text before the brace includes leading whitespace/comments
    // which must be pushed as `text` up to the start of the selector.
    // We split at the last `\n` before brace — everything up to that
    // newline is pre-rule text; everything after is the selector head.
    const preBreak = src.lastIndexOf("\n", brace);
    let selectorStart;
    if (preBreak === -1) {
      selectorStart = i;
    } else if (preBreak >= i) {
      selectorStart = preBreak + 1;
      pushText(src.slice(i, preBreak + 1));
    } else {
      selectorStart = i;
    }

    // For grouped selectors spanning multiple lines, walk backwards
    // collecting all lines ending in `,`. selectorStart should cover
    // them.
    {
      let s = selectorStart;
      while (s > i) {
        const prevBreak = src.lastIndexOf("\n", s - 2);
        const lineStart = prevBreak === -1 ? 0 : prevBreak + 1;
        const line = src.slice(lineStart, s - 1);
        if (/,\s*$/.test(line)) {
          s = lineStart;
        } else break;
      }
      if (s < selectorStart) {
        pushText(src.slice(i, s).slice(0, s - i));
        selectorStart = s;
      }
    }

    const selectorText = src.slice(selectorStart, brace).trimEnd();

    // Find matching closing brace, respecting nested braces (for
    // @keyframes, @supports, :is() etc.).
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      const ch = src[j];
      if (ch === "/" && src[j + 1] === "*") {
        const end = src.indexOf("*/", j + 2);
        if (end === -1) {
          j = n;
          break;
        }
        j = end + 2;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      j++;
    }
    if (depth !== 0) {
      // Unbalanced — bail out, keep remainder as text
      pushText(src.slice(i));
      return out;
    }

    const body = src.slice(brace, j);
    out.push({
      kind: "rule",
      selector: selectorText,
      body,
      full: src.slice(selectorStart, j),
      leading: src.slice(selectorStart, brace),
    });
    i = j;
  }

  return out;
}

// ── 3. Extract class tokens referenced in a selector string.
function classesInSelector(sel) {
  const set = new Set();
  const re = /\.(zeros-[a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = re.exec(sel)) !== null) set.add(m[1]);
  return set;
}

// Split a single selector into compound-selector segments separated
// by combinators (space, >, +, ~). Returns each segment's .zeros-* class set.
function compoundClassSets(sel) {
  // Replace combinators with a single space for uniform splitting.
  const normalized = sel.replace(/\s*[>+~]\s*/g, " ");
  const segments = normalized.trim().split(/\s+/).filter(Boolean);
  return segments.map((seg) => {
    const set = new Set();
    const re = /\.(zeros-[a-zA-Z0-9_-]+)/g;
    let m;
    while ((m = re.exec(seg)) !== null) set.add(m[1]);
    return set;
  });
}

// A single-selector rule is dead if ANY compound segment is composed
// entirely of dead classes (that segment can never match any DOM,
// so neither can the whole descendant chain).
function selectorIsDead(sel, dead) {
  const segments = compoundClassSets(sel);
  // If no segment references any .zeros-* class at all (e.g. `${S} button`),
  // we don't touch the rule.
  const anyReferencesOc = segments.some((s) => s.size > 0);
  if (!anyReferencesOc) return false;
  for (const seg of segments) {
    if (seg.size === 0) continue;
    let allDead = true;
    for (const c of seg) if (!dead.has(c)) { allDead = false; break; }
    if (allDead) return true;
  }
  return false;
}

// ── 4. Decide whether to drop a rule given the dead set.
//     Returns:
//       { keep: false }                     → drop whole rule
//       { keep: true, selector: <string> }  → keep, possibly with
//                                              trimmed selector list
function decide(rule, dead) {
  const selectors = rule.selector
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Only touch rules that reference .zeros-* classes. Everything else
  // (keyframes, html-element selectors, :root, @rules etc.) left alone.
  const referencesOc = selectors.some((s) => /\.zeros-[a-zA-Z0-9_-]+/.test(s));
  if (!referencesOc) return { keep: true };

  const aliveSelectors = [];
  for (const s of selectors) {
    const cls = classesInSelector(s);
    if (cls.size === 0) {
      // e.g. `${S} button`, `${S} input[type=range]` — keep.
      aliveSelectors.push(s);
      continue;
    }
    if (!selectorIsDead(s, dead)) aliveSelectors.push(s);
  }

  if (aliveSelectors.length === 0) return { keep: false };
  if (aliveSelectors.length === selectors.length) return { keep: true };
  return { keep: true, selector: aliveSelectors.join(",\n") };
}

// ── 5. Rewrite a file. Target is the template literal contents
//     inside backticks. We rewrite the WHOLE file content line
//     by line, treating it as one long string — the parser handles
//     rule boundaries.
function rewrite(filePath, dead) {
  const src = fs.readFileSync(filePath, "utf8");
  const blocks = parseBlocks(src);
  const out = [];
  let dropped = 0;
  let trimmed = 0;
  for (const b of blocks) {
    if (b.kind === "text") {
      out.push(b.content);
      continue;
    }
    const d = decide(b, dead);
    if (!d.keep) {
      dropped++;
      // Remove any trailing blank line that immediately precedes.
      continue;
    }
    if (d.selector !== undefined) {
      trimmed++;
      // Reassemble: replace selector head with new selector joined by `,\n`.
      out.push(d.selector + " " + b.body);
    } else {
      out.push(b.full);
    }
  }

  const next = out.join("");
  if (next !== src) {
    fs.writeFileSync(filePath, next);
  }
  return { dropped, trimmed, before: src.length, after: next.length };
}

// ── 6. Orchestrate ─────────────────────────────────────
const dead = deadSetFromScanner();
console.log(`Scanner reported ${dead.size} dead engine classes.`);
if (dead.size === 0) process.exit(0);

const TARGETS = [
  "zeros/engine/zeros-styles.ts",
  "zeros/engine/styles/canvas.ts",
  "zeros/engine/styles/command-palette.ts",
  "zeros/engine/styles/panels.ts",
  "zeros/engine/styles/settings.ts",
  "zeros/engine/styles/style-panel.ts",
  "zeros/engine/styles/toolbar.ts",
].map((p) => path.join(ROOT, p));

let totalDropped = 0;
let totalTrimmed = 0;
let totalSaved = 0;
for (const f of TARGETS) {
  if (!fs.existsSync(f)) continue;
  const rel = path.relative(process.cwd(), f);
  const { dropped, trimmed, before, after } = rewrite(f, dead);
  if (dropped === 0 && trimmed === 0) {
    console.log(`  = ${rel}: no changes`);
    continue;
  }
  totalDropped += dropped;
  totalTrimmed += trimmed;
  totalSaved += before - after;
  console.log(
    `  ✓ ${rel}: dropped ${dropped} block(s), trimmed ${trimmed} group(s) — ${
      before - after
    } bytes saved`,
  );
}

console.log(
  `\nTotal — dropped ${totalDropped} rule blocks, trimmed ${totalTrimmed} grouped selectors, saved ${totalSaved} bytes.`,
);
