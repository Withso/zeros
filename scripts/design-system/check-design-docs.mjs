// ============================================================
// check-design-docs.mjs
// ------------------------------------------------------------
// Keeps the design-system docs honest. Agents follow what the guide names, so
// a token, command, path, or class mentioned there must exist:
//
//   • `--token` custom properties  → declared in an owned stylesheet or @theme
//   • `pnpm <script>` commands     → defined in package.json
//   • `path/to/file` spans + links → exist (repo-, renderer-, or doc-relative)
//   • class spans (`bg-bg1 text-fg2`) → compile against the app's Tailwind entry
//
// Classes the guide cites as things that do NOT compile are listed in
// COUNTEREXAMPLES — and must keep failing, or the example is stale.
// Run through `pnpm check:ui`.
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  cssDefinedClasses,
  compileCandidates,
  KNOWN_HOOK_CLASSES,
  ownedStylesheets,
} from "./check-compiled-classes.mjs";

// Agent-facing design docs. A `section` limits a shared file to its UI part.
// docs/design-system-history.md is deliberately excluded: it records names
// that no longer exist.
export const CHECKED_DOCS = [
  { rel: "docs/design-system.md" },
  { rel: "docs/design-tokens.md" },
  { rel: "RULES.md", section: "## 3. UI and styling" },
];

// Cited in the guide precisely because they compile to nothing.
export const COUNTEREXAMPLES = new Set([
  "text-error",
  "bg-sidebar",
  "rounded-xl",
  "bg-gray-500",
  "text-white",
]);

const PNPM_BUILTINS = new Set(["exec", "install", "dlx", "add", "-s"]);
// File-name conventions of the Design feature and CSS property names: prose,
// not repository paths or utilities.
const PROSE_TERMS = new Set([
  "design.toml",
  "canvas.json",
  "rules.md",
  "tokens.css",
  "z-index",
  "font-size",
  "line-height",
  "border-color",
  "border-radius",
  "box-shadow",
  "outline-color",
  "color-scheme",
]);
const PATH_EXTENSIONS = /\.(?:md|mdc|ts|tsx|mts|mjs|js|css|json|toml|html)$/;
// Anything shaped like a utility, bare (`flex`) or with variants.
const CLASS_TOKEN_RE = /^!?-?[a-z][\w:/.%#,=()[\]&*!-]*$/;
// Utility families: a span containing one of these is treated as classes even
// when nothing in it compiles (`bg-surface-0`), so typos cannot hide as prose.
const UTILITY_PREFIX_RE =
  /^(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|decoration|caret|accent|shadow|rounded|p[xytrblse]?|m[xytrblse]?|gap|space|size|[hw]|min-[hw]|max-[hw]|z|font|leading|tracking|opacity|transition|duration|ease|inset|top|left|right|bottom|grid|flex|items|justify|self|place|overflow|cursor|select)-/;

function declaredCustomProperties(root) {
  const names = new Set();
  for (const file of ownedStylesheets(root)) {
    for (const match of readFileSync(file, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(match[1]);
  }
  return names;
}

function backtickSpans(markdown) {
  const spans = [];
  // Skip fenced code blocks: they show file trees and shell, not references.
  const lines = markdown.split(/\r?\n/);
  let fenced = false;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    for (const match of line.matchAll(/`([^`]+)`/g)) spans.push({ text: match[1], line: index + 1 });
  });
  return spans;
}

function markdownLinks(markdown) {
  const links = [];
  markdown.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      if (!/^[a-z]+:/i.test(match[1])) links.push({ target: match[1], line: index + 1 });
    }
  });
  return links;
}

function sectionOf(markdown, heading) {
  const start = markdown.indexOf(heading);
  if (start === -1) return null;
  const next = markdown.indexOf("\n## ", start + heading.length);
  // Keep line numbers meaningful: blank out everything outside the section.
  const before = markdown.slice(0, start).replace(/[^\n]/g, "");
  return before + markdown.slice(start, next === -1 ? undefined : next);
}

function pathExists(root, docRel, candidate) {
  const clean = candidate.replace(/[),.;:]+$/, "");
  const bases = [
    root,
    join(root, dirname(docRel)),
    join(root, "apps/desktop/src"),
    join(root, "apps/desktop/src/renderer"),
  ];
  if (clean.startsWith("@/")) return existsSync(join(root, "apps/desktop/src", clean.slice(2)));
  return bases.some((base) => existsSync(join(base, clean)));
}

/**
 * @param {object} options
 * @param {string} options.root repository root
 * @param {object} [options.designSystem] Tailwind design system (class checks)
 * @param {Array<{rel: string, markdown: string}>} [options.docs] in-memory docs
 *   (tests); defaults to reading CHECKED_DOCS
 */
export async function checkDesignDocs({ root, designSystem, docs }) {
  const violations = [];
  const properties = declaredCustomProperties(root);
  const tokensCss = readFileSync(join(root, "styles/zeros-tokens.css"), "utf8");
  for (const match of tokensCss.matchAll(/(--[a-z0-9-]+(?:--[a-z0-9-]+)?)\s*:/g)) properties.add(match[1]);
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts ?? {};
  const cssClasses = cssDefinedClasses(ownedStylesheets(root).map((file) => readFileSync(file, "utf8")));

  const classChecks = [];
  const sources =
    docs ??
    CHECKED_DOCS.map(({ rel, section }) => {
      if (!existsSync(join(root, rel))) return { rel, markdown: null };
      const text = readFileSync(join(root, rel), "utf8");
      return { rel, markdown: section ? sectionOf(text, section) : text };
    });
  for (const { rel: docRel, markdown } of sources) {
    if (markdown === null) {
      violations.push({ file: docRel, line: 1, message: "Design-system doc is missing." });
      continue;
    }

    for (const { target, line } of markdownLinks(markdown)) {
      if (!pathExists(root, docRel, target)) {
        violations.push({ file: docRel, line, message: `Broken link: ${target}` });
      }
    }

    for (const { text, line } of backtickSpans(markdown)) {
      if (PROSE_TERMS.has(text)) continue;
      if (/^pnpm\s/.test(text)) {
        const words = text.split(/\s+/).slice(1).filter((word) => !word.startsWith("-"));
        const script = words[0] === "run" ? words[1] : words[0];
        if (script && !PNPM_BUILTINS.has(script) && !scripts[script]) {
          violations.push({ file: docRel, line, message: `\`${text}\`: no "${script}" script in package.json.` });
        }
        continue;
      }
      // Custom properties anywhere in the span (var(--x), --x, --x: value);
      // patterns such as --<family>-bg or --color-* are placeholders.
      for (const match of text.matchAll(/(?<![\w-])--[a-z0-9][\w<>*-]*/g)) {
        const name = match[0];
        if (/[<>*]/.test(name)) continue;
        if (!properties.has(name)) {
          violations.push({ file: docRel, line, message: `\`${name}\` is not declared in any owned stylesheet.` });
        }
      }
      const isPath =
        !/\s/.test(text) &&
        !text.startsWith("--") &&
        !/[<>*:]/.test(text) &&
        ((text.endsWith("/") && text.includes("/")) || PATH_EXTENSIONS.test(text));
      if (isPath) {
        if (!pathExists(root, docRel, text)) {
          violations.push({ file: docRel, line, message: `\`${text}\` does not exist.` });
        }
        continue;
      }
      const tokens = text.split(/\s+/).filter(Boolean);
      if (
        tokens.length &&
        tokens.every((token) => CLASS_TOKEN_RE.test(token) && !token.includes("*") && !token.startsWith("--"))
      ) {
        classChecks.push({ tokens, file: docRel, line });
      }
    }
  }

  if (classChecks.length && designSystem) {
    const compiled = compileCandidates(designSystem, [...classChecks.flatMap((c) => c.tokens), ...COUNTEREXAMPLES]);
    const known = (token) =>
      compiled.get(token) || cssClasses.has(token) || COUNTEREXAMPLES.has(token) || KNOWN_HOOK_CLASSES.some((entry) => entry.match(token));
    const base = (token) => token.slice(token.lastIndexOf(":") + 1).replace(/^!|!$/g, "").replace(/^-/, "");
    for (const { tokens, file, line } of classChecks) {
      // A span is class markup when part of it compiles or it uses a utility
      // family; otherwise it is prose (`check:ui ignore`, `zeros-ui`).
      const isClassSpan = tokens.some((token) => compiled.get(token)) || tokens.some((token) => UTILITY_PREFIX_RE.test(base(token)));
      if (!isClassSpan) continue;
      for (const token of tokens) {
        if (!known(token)) {
          violations.push({ file, line, message: `Class \`${token}\` named in the docs compiles to nothing.` });
        }
      }
    }
    for (const example of COUNTEREXAMPLES) {
      if (compiled.get(example)) {
        violations.push({
          file: "scripts/design-system/check-design-docs.mjs",
          line: 1,
          message: `COUNTEREXAMPLES entry \`${example}\` now compiles — the docs' "does not compile" example is stale.`,
        });
      }
    }
  }
  return violations;
}
