#!/usr/bin/env node
/**
 * Find dead engine-CSS rules — `.zeros-*` class selectors defined
 * inside `src/zeros/engine/styles/*.ts` template literals that
 * are never rendered by any TSX/TS file (and therefore target
 * nothing at runtime).
 *
 * Heuristic:
 *   - Scan engine style files for `${S} .zeros-<name>` selector patterns.
 *   - Check if `zeros-<name>` appears as a className/className literal
 *     anywhere in .ts/.tsx outside engine/styles/**.
 *   - Report unused.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd(), "src");
const STYLES_DIR = path.join(ROOT, "zeros/engine/styles");
const STYLES_MAIN = path.join(ROOT, "zeros/engine/zeros-styles.ts");

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?|html)$/.test(name)) out.push(p);
  }
  return out;
}

const ALL_FILES = walk(ROOT);
// Exclude engine-style definition files from "usage"; we want USES, not DEFS.
const CONSUMERS = ALL_FILES.filter(
  (f) =>
    !f.startsWith(STYLES_DIR + path.sep) &&
    f !== STYLES_MAIN,
);
const CONSUMER_TEXT = CONSUMERS.map((f) => fs.readFileSync(f, "utf8")).join("\n");

function classesInFile(text) {
  const set = new Set();
  // Match `.zeros-<anything hyphenated/underscored>` — greedy to end of identifier.
  const re = /\.(zeros-[a-zA-Z0-9_-]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    set.add(m[1]);
  }
  return [...set];
}

function isUsed(cls) {
  const re = new RegExp(`(^|[^a-zA-Z0-9_-])${cls}([^a-zA-Z0-9_-]|$)`);
  return re.test(CONSUMER_TEXT);
}

// Collect classes per engine style file
const toCheck = [];
if (fs.existsSync(STYLES_MAIN)) toCheck.push(STYLES_MAIN);
if (fs.existsSync(STYLES_DIR)) {
  for (const name of fs.readdirSync(STYLES_DIR)) {
    toCheck.push(path.join(STYLES_DIR, name));
  }
}

let totalDead = 0;
for (const f of toCheck) {
  const rel = path.relative(process.cwd(), f);
  const text = fs.readFileSync(f, "utf8");
  const classes = classesInFile(text);
  const dead = classes.filter((c) => !isUsed(c));
  if (!dead.length) {
    console.log(`✓ ${rel} — no dead rules (${classes.length} classes defined)`);
    continue;
  }
  totalDead += dead.length;
  console.log(`\n✗ ${rel} — ${dead.length}/${classes.length} dead class(es):`);
  for (const d of dead.sort()) console.log(`    .${d}`);
}

console.log(`\nTotal dead engine classes: ${totalDead}`);
