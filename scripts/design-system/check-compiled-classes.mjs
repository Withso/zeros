// ============================================================
// check-compiled-classes.mjs
// ------------------------------------------------------------
// Every class the renderer writes must produce CSS. Tailwind never errors on
// an unknown utility — `text-error`, `bg-sidebar`, or a removed `rounded-xl`
// simply render nothing — so a typo or a retired token silently drops the
// intended styling. This check compiles each class candidate against the real
// app entrypoint (styles/zeros-tokens.css) with the SAME Tailwind compiler the
// Vite build uses, and reports any candidate that emits no CSS and is not a
// known non-utility class.
//
// Known non-utility classes, each with a reason:
//   • state markers: group, peer, group/<name>, peer/<name>
//   • classes defined by owned CSS (styles/**, renderer *.css) — discovered
//     automatically from selectors, so a new stylesheet class needs no entry
//   • KNOWN_HOOK_CLASSES below — vendor or JS hook classes styled elsewhere;
//     every entry must still be used, or the check reports it as stale
//
// Run through `pnpm check:ui`; `node scripts/design-system/check-compiled-classes.mjs`
// runs it alone.
// ============================================================
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { extractClassCandidates } from "./class-candidates.mjs";

export const TAILWIND_ENTRY = "styles/zeros-tokens.css";

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-engine", ".git", "__tests__"]);

// Classes that are intentionally not Tailwind utilities and are not defined in
// an owned stylesheet. Non-utility classes must be NAMESPACED so they can never
// be mistaken for a utility (and a utility typo can never pass as a hook).
// Keep this list short: each entry needs a reason, and an entry that no longer
// matches any candidate fails the check as stale.
export const KNOWN_HOOK_CLASSES = [
  {
    why: "app DOM hooks — zeros-* classes read by selectors, tests, runtime CSS, and the index.html boot splash",
    match: (token) => /^zeros-[a-z0-9-]+$/.test(token),
  },
  {
    why: "Design workspace hooks — the zd-* namespace of the design-workspace stylesheets",
    match: (token) => /^zd-[a-z0-9-]+$/.test(token),
  },
  {
    why: "state flags paired with a namespaced hook (e.g. zeros-agent-turn-prompt is-editing)",
    match: (token) => /^is-[a-z][a-z-]*$/.test(token),
  },
];

const STATE_MARKER_RE = /^(?:group|peer)(?:\/[\w-]+)?$/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function toRel(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

/** Renderer sources that carry class markup (tests and fixtures excluded). */
export function rendererSourceFiles(root) {
  return walk(join(root, "apps/desktop/src/renderer")).filter(
    (file) =>
      /\.(?:ts|tsx)$/.test(file) &&
      !file.endsWith(".d.ts") &&
      !/\.(?:test|spec)\.[jt]sx?$/.test(file),
  );
}

/** Class names defined by selectors in owned stylesheets. */
export function cssDefinedClasses(cssSources) {
  const classes = new Set();
  for (const source of cssSources) {
    const css = source.replace(/\/\*[\s\S]*?\*\//g, " ");
    let prelude = "";
    for (const ch of css) {
      if (ch === "{") {
        const text = prelude.trim();
        if (!text.startsWith("@")) {
          for (const match of text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) classes.add(match[1]);
        }
        prelude = "";
      } else if (ch === "}" || ch === ";") {
        prelude = "";
      } else {
        prelude += ch;
      }
    }
  }
  return classes;
}

export function ownedStylesheets(root) {
  return [
    ...walk(join(root, "styles")).filter(
      (file) => extname(file) === ".css" && !toRel(root, file).startsWith("styles/Artifacts/"),
    ),
    ...walk(join(root, "apps/desktop/src/renderer")).filter((file) => extname(file) === ".css"),
  ];
}

/**
 * Load Tailwind's design system for the app entrypoint using the compiler the
 * Vite build resolves (`@tailwindcss/vite` → `@tailwindcss/node`), so the check
 * can never disagree with the bundle about which classes exist.
 */
export async function loadDesignSystem(root, entry = TAILWIND_ENTRY) {
  const rootRequire = createRequire(join(root, "package.json"));
  const viteRequire = createRequire(rootRequire.resolve("@tailwindcss/vite"));
  const { __unstable__loadDesignSystem } = viteRequire("@tailwindcss/node");
  return __unstable__loadDesignSystem(readFileSync(join(root, entry), "utf8"), {
    base: join(root, "styles"),
  });
}

/** Map of candidate → whether it compiles, computed in one batch. */
export function compileCandidates(designSystem, candidates) {
  const unique = [...new Set(candidates)];
  const css = designSystem.candidatesToCss(unique);
  return new Map(unique.map((candidate, index) => [candidate, Boolean(css[index])]));
}

/**
 * @returns {Promise<Array<{file: string, line: number, message: string}>>}
 */
export async function checkCompiledClasses({ root, files, occurrences: extracted, designSystem, hookClasses = KNOWN_HOOK_CLASSES, cssSources } = {}) {
  const occurrences =
    extracted ?? extractClassCandidates({ files: files ?? rendererSourceFiles(root), root });
  const ds = designSystem ?? (await loadDesignSystem(root));
  const compiled = compileCandidates(ds, occurrences.map((o) => o.token));
  const defined = cssDefinedClasses(
    cssSources ?? ownedStylesheets(root).map((file) => readFileSync(file, "utf8")),
  );

  const violations = [];
  const usedHooks = new Set();
  for (const occurrence of occurrences) {
    const { token } = occurrence;
    if (compiled.get(token)) continue;
    if (STATE_MARKER_RE.test(token)) continue;
    if (defined.has(token)) continue;
    const hook = hookClasses.find((entry) => entry.match(token));
    if (hook) {
      usedHooks.add(hook);
      continue;
    }
    violations.push({
      file: toRel(root, occurrence.file),
      line: occurrence.line,
      message: `Class "${token}" compiles to nothing — Tailwind silently drops unknown utilities, so the intended style never renders. Use an existing token utility (see docs/design-system.md), or define the class in an owned stylesheet.`,
    });
  }
  for (const entry of hookClasses) {
    if (!usedHooks.has(entry)) {
      violations.push({
        file: "scripts/design-system/check-compiled-classes.mjs",
        line: 1,
        message: `Stale KNOWN_HOOK_CLASSES entry "${entry.why}" — it no longer matches any class candidate; remove it.`,
      });
    }
  }
  return violations;
}

// Standalone run: node scripts/design-system/check-compiled-classes.mjs
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = process.cwd();
  const violations = await checkCompiledClasses({ root });
  if (violations.length === 0) {
    console.log("check-compiled-classes — clean");
  } else {
    for (const v of violations) console.log(`${v.file}:${v.line}  ${v.message}`);
    console.log(`\n${violations.length} class(es) compile to nothing.`);
    process.exitCode = 1;
  }
}
