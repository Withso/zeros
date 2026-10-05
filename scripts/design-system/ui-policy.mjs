// ============================================================
// ui-policy.mjs
// ------------------------------------------------------------
// Design-system policy for renderer class markup, enforced with a ratchet.
//
// Each rule inspects the class candidates extracted from the TypeScript AST
// (class-candidates.mjs) or the JSX element tree, and names a finding by
// (rule, file, key). Existing findings are recorded as DEBT in
// styles/policy/ui-debt.json; `pnpm check:ui` fails when:
//   • a (rule, file, key) count rises above its recorded debt (new drift), or
//   • a count falls below it (debt was paid — prune the ledger so the freed
//     budget can never be spent again: `pnpm check:ui --prune-debt`).
// Intentional, reviewed deviations go in the ledger's `exceptions` list with
// a reason instead. New `check:ui ignore-*` directives are themselves a
// ratcheted finding (ui/ignore-directive), so an ignore comment cannot quietly
// replace a fix.
//
// Granularity: the ledger counts (rule, file, key). Moving an existing
// violation within one file — or swapping it for an identical one — is not
// detected; changes to the ledger itself are owner-reviewed (CODEOWNERS).
//
// Product UI only: harness pages and tests are out of scope. Rationale and
// the replacement for each rule: docs/design-system.md.
// ============================================================
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

import { extractClassContexts } from "./class-candidates.mjs";

export const DEBT_FILE = "styles/policy/ui-debt.json";

// Spacing steps (Tailwind units) shared with the CSS px scale in
// check-ui-consistency.mjs: 0 2 4 6 8 10 12 14 16 20 24 28 32 40 48 px.
export const SPACING_STEPS = new Set([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12]);

const COLOR_PREFIX =
  "bg|border(?:-[xytrblse])?|ring|outline|fill|stroke|from|via|to|decoration|caret|accent|divide|text";
const ARBITRARY_RE = new RegExp(
  `^(text|leading|tracking|rounded(?:-[trblse]{1,2})?|z|shadow|-?p[xytrblse]?|-?m[xytrblse]?|gap(?:-[xy])?|space-[xy]|${COLOR_PREFIX})-\\[(.+)\\]$`,
);

/** The utility without variants (`hover:`, `data-[…]:`) or important markers. */
export function baseUtility(token) {
  let depth = 0;
  let last = 0;
  for (let i = 0; i < token.length; i += 1) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth += 1;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) last = i + 1;
  }
  return token.slice(last).replace(/^!|!$/g, "");
}

const tokenValueIsDesignToken = (value) =>
  /^var\(--[\w-]+\)$/.test(value) ||
  // Derived values built from a token, e.g. calc(var(--radius-lg)*1.5).
  (/var\(--[\w-]+\)/.test(value) && !/#|rgba?\(|hsla?\(|oklch\(/.test(value));

/** Class-token rules: return a finding key, or null when the token is fine. */
export const CLASS_RULES = [
  {
    id: "arbitrary-value",
    message: (key) =>
      `"${key}" is a raw visual value. Use the scale or a token: text-xxs…text-sm / leading-* / rounded-sm|md|lg / z-panel|chrome|dropdown|modal|toast / spacing steps / color tokens (docs/design-system.md).`,
    test(base) {
      const match = base.match(ARBITRARY_RE);
      if (!match) return null;
      const [, property, value] = match;
      if (tokenValueIsDesignToken(value)) return null;
      // Stroke/outline widths are geometry, not color: ring-[3px], border-[1.5px].
      if (/^(?:ring|border|outline|stroke|divide)/.test(property) && /^\d+(?:\.\d+)?(?:px)?$/.test(value)) {
        return null;
      }
      if (property === "rounded" && value === "inherit") return null;
      if (property === "z" && /^[0-2]$/.test(value)) return null; // local stacking
      // `text-[length:…]`-style hints and non-size text values stay flagged.
      return base;
    },
  },
  {
    id: "numeric-z",
    message: (key) =>
      `"${key}" — global layers use z-panel | z-chrome | z-dropdown | z-modal | z-toast (styles/global/platform.css); only z-0…z-2 are free for local stacking.`,
    test(base) {
      const match = base.match(/^-?z-(\d+)$/);
      return match && Number(match[1]) > 2 ? base : null;
    },
  },
  {
    id: "stock-shadow",
    message: (key) =>
      `"${key}" is Tailwind's theme-static shadow. Floating surfaces use shadow-[var(--shadow-dropdown)], which re-themes for Light.`,
    test(base) {
      return /^shadow(?:-(?:2xs|xs|sm|md|lg|xl|2xl))?$/.test(base) ? base : null;
    },
  },
  {
    id: "text-alpha",
    message: (key) =>
      `"${key}" invents a text tier with opacity, which skips the contrast contract. Use fg1 / fg2 / fg3 / muted-fg.`,
    test(base) {
      // Any opacity syntax: /60, /[.6], /20.5, /(--alpha).
      return /^text-(?:fg[123]|muted-fg)\/.+$/.test(base) ? base : null;
    },
  },
  {
    id: "off-scale-spacing",
    message: (key) =>
      `"${key}" is off the spacing scale (0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8, 10, 12).`,
    test(base) {
      const match = base.match(
        /^-?(?:p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy])-(\d+(?:\.\d+)?)$/,
      );
      return match && !SPACING_STEPS.has(Number(match[1])) ? base : null;
    },
  },
  {
    id: "off-scale-text",
    message: (key) =>
      `"${key}" is off the type scale. Chrome text uses text-xxs | text-2xxs | text-3xxs | text-xs | text-sm (titles: text-base / text-lg / text-dialog-title).`,
    test(base) {
      return /^text-(?:xl|[2-9]xl)$/.test(base) ? base : null;
    },
  },
  {
    id: "transition-all",
    message: () =>
      `"transition-all" animates layout properties. Name the properties: transition-colors, transition-opacity, transition-transform, or transition-[…].`,
    test(base) {
      return base === "transition-all" ? base : null;
    },
  },
  {
    id: "dark-variant",
    message: (key) =>
      `"${key}" — theme logic belongs in tokens, not components. Use a token that already re-themes (styles/zeros-tokens.css).`,
    test(base, token) {
      return /(?:^|:)dark:/.test(token) ? token : null;
    },
  },
];

const FAMILIES = ["red", "green", "yellow", "blue", "violet", "brown"];

/** Rules over all tokens that land on one element (one class context). */
export const GROUP_RULES = [
  {
    id: "status-pairing",
    message: (key) =>
      `${key}: text on a --<family>-bg container uses text-<family>-fg, not the vivid -primary (styles/policy/contrast-contract.json).`,
    test(bases) {
      const findings = [];
      for (const family of FAMILIES) {
        if (bases.has(`bg-${family}-bg`) && bases.has(`text-${family}-primary`)) {
          findings.push(`text-${family}-primary on bg-${family}-bg`);
        }
      }
      return findings;
    },
  },
];

export const IGNORE_DIRECTIVE_RULE = {
  id: "ignore-directive",
  key: "check:ui ignore",
  message: () =>
    "New `check:ui ignore` directive. Fix the finding instead; a reviewed boundary (brand or user color, canvas API) goes in styles/policy/ui-debt.json `exceptions` with a reason.",
};

export const KNOWN_RULES = new Set([
  ...CLASS_RULES.map((rule) => rule.id),
  ...GROUP_RULES.map((rule) => rule.id),
  "raw-control",
  "ignore-directive",
]);

const RAW_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);

export const RAW_CONTROL_RULE = {
  id: "raw-control",
  message: (key) =>
    `Raw <${key}> outside shared/ui. Use the shared primitive (Button, Input, Select, Textarea, Checkbox, …) so size, focus, and states stay consistent; extend the primitive if it lacks a variant.`,
};

function toRel(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

export function isPolicyScoped(rel) {
  return (
    rel.startsWith("apps/desktop/src/renderer/") &&
    !rel.startsWith("apps/desktop/src/renderer/harnesses/") &&
    !/(^|\/)__tests__\//.test(rel) &&
    !/\.(?:test|spec)\.[jt]sx?$/.test(rel)
  );
}

/** Raw native controls in JSX (hidden and file inputs have no primitive). */
export function findRawControls(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sourceFile);
      if (RAW_CONTROL_TAGS.has(tag)) {
        let exempt = false;
        if (tag === "input") {
          for (const attribute of node.attributes.properties) {
            if (
              ts.isJsxAttribute(attribute) &&
              attribute.name.getText(sourceFile) === "type" &&
              attribute.initializer &&
              ts.isStringLiteral(attribute.initializer) &&
              /^(?:file|hidden)$/.test(attribute.initializer.text)
            ) {
              exempt = true;
            }
          }
        }
        if (!exempt) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          findings.push({ key: tag, line: line + 1 });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** Lines covered by a reviewed `check:ui ignore-line` / `ignore-next` directive. */
function ignoredLines(source) {
  const ignored = new Set();
  source.split(/\r?\n/).forEach((line, index) => {
    if (/check:ui\s+ignore-line/.test(line)) ignored.add(index + 1);
    if (/check:ui\s+ignore-next/.test(line)) ignored.add(index + 2);
  });
  return ignored;
}

/**
 * All policy findings: [{ rule, file, key, line, message }].
 */
export function collectFindings({ root, files, contexts }) {
  const scoped = files.filter((file) => isPolicyScoped(toRel(root, file)));
  // Reuse a caller's extraction (check:ui shares one AST pass); anything
  // outside the policy scope is filtered below.
  const { occurrences, groups } = contexts ?? extractClassContexts({ files: scoped, root });
  const findings = [];

  for (const occurrence of occurrences) {
    const rel = toRel(root, occurrence.file);
    if (!isPolicyScoped(rel)) continue; // reached through an imported recipe
    const base = baseUtility(occurrence.token);
    for (const rule of CLASS_RULES) {
      const key = rule.test(base, occurrence.token);
      if (key) {
        findings.push({ rule: rule.id, file: rel, key, line: occurrence.line, message: rule.message(key) });
      }
    }
  }

  // Pairing: a group's own classes plus its ancestors' (cva base + one
  // variant option). A child reports only pairs its parent does not already
  // have, so one recipe's base pairing is counted once.
  const basesOf = (id) => {
    const out = new Set();
    for (let cursor = id; cursor; cursor = groups.get(cursor)?.parent ?? null) {
      for (const token of groups.get(cursor)?.tokens ?? []) out.add(baseUtility(token));
    }
    return out;
  };
  for (const [id, group] of groups) {
    const rel = toRel(root, group.file);
    if (!isPolicyScoped(rel)) continue;
    for (const rule of GROUP_RULES) {
      const inherited = group.parent ? new Set(rule.test(basesOf(group.parent))) : new Set();
      for (const key of rule.test(basesOf(id))) {
        if (inherited.has(key)) continue;
        findings.push({ rule: rule.id, file: rel, key, line: group.line, message: rule.message(key) });
      }
    }
  }

  for (const file of scoped) {
    if (!file.endsWith(".tsx")) continue;
    const rel = toRel(root, file);
    if (rel.startsWith("apps/desktop/src/renderer/shared/ui/")) continue;
    for (const finding of findRawControls(file, readFileSync(file, "utf8"))) {
      findings.push({
        rule: RAW_CONTROL_RULE.id,
        file: rel,
        key: finding.key,
        line: finding.line,
        message: RAW_CONTROL_RULE.message(finding.key),
      });
    }
  }
  // Ignore directives are themselves ratcheted: each one is a finding, so a
  // new directive fails like any other new finding.
  for (const file of scoped) {
    const rel = toRel(root, file);
    readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
      if (/check:ui\s+ignore-(?:line|next)/.test(line)) {
        findings.push({
          rule: IGNORE_DIRECTIVE_RULE.id,
          file: rel,
          key: IGNORE_DIRECTIVE_RULE.key,
          line: index + 1,
          message: IGNORE_DIRECTIVE_RULE.message(),
        });
      }
    });
  }

  // Honor the reviewed line directives check-ui-consistency.mjs already uses
  // (their count is held by ui/ignore-directive above).
  const ignoredByFile = new Map();
  return findings.filter((finding) => {
    if (finding.rule === IGNORE_DIRECTIVE_RULE.id) return true;
    if (!ignoredByFile.has(finding.file)) {
      ignoredByFile.set(finding.file, ignoredLines(readFileSync(join(root, finding.file), "utf8")));
    }
    return !ignoredByFile.get(finding.file).has(finding.line);
  });
}

/** Count findings as ledger[rule][file][key]. */
export function tally(findings) {
  const ledger = {};
  for (const { rule, file, key } of findings) {
    ledger[rule] ??= {};
    ledger[rule][file] ??= {};
    ledger[rule][file][key] = (ledger[rule][file][key] ?? 0) + 1;
  }
  return sortLedger(ledger);
}

function sortLedger(ledger) {
  const sorted = {};
  for (const rule of Object.keys(ledger).sort()) {
    sorted[rule] = {};
    for (const file of Object.keys(ledger[rule]).sort()) {
      sorted[rule][file] = {};
      for (const key of Object.keys(ledger[rule][file]).sort()) {
        sorted[rule][file][key] = ledger[rule][file][key];
      }
    }
  }
  return sorted;
}

function isExcepted(exceptions, { rule, file, key }) {
  return exceptions.some(
    (entry) => entry.rule === rule && entry.file === file && entry.key === key,
  );
}

/**
 * Compare findings to the ledger. Returns { violations, pruned } where
 * `pruned` is the ledger after shrinking every entry to its current count.
 */
export function compareToLedger(findings, ledgerFile) {
  const debt = ledgerFile.debt ?? {};
  const exceptions = ledgerFile.exceptions ?? [];
  const violations = [];

  // An exception is a reviewed decision: it names a known rule and says why.
  const validExceptions = exceptions.filter((entry, index) => {
    const problems = [];
    if (!KNOWN_RULES.has(entry?.rule)) problems.push(`unknown rule "${entry?.rule}"`);
    if (typeof entry?.file !== "string" || !entry.file) problems.push("missing file");
    if (typeof entry?.key !== "string" || !entry.key) problems.push("missing key");
    if (typeof entry?.reason !== "string" || entry.reason.trim().length < 10) problems.push("missing reason");
    if (problems.length) {
      violations.push({
        kind: "invalid-exception",
        file: DEBT_FILE,
        line: 1,
        message: `exceptions[${index}] is invalid (${problems.join(", ")}). Every exception needs a known rule, file, key, and a reason.`,
      });
      return false;
    }
    return true;
  });
  for (const [rule, files] of Object.entries(debt)) {
    if (!KNOWN_RULES.has(rule)) {
      violations.push({ kind: "invalid-debt", file: DEBT_FILE, line: 1, message: `debt for unknown rule "${rule}".` });
    }
    for (const [file, keys] of Object.entries(files ?? {})) {
      for (const [key, count] of Object.entries(keys ?? {})) {
        if (!Number.isInteger(count) || count < 1) {
          violations.push({ kind: "invalid-debt", file: DEBT_FILE, line: 1, message: `debt ${rule} ${file} "${key}" must be a positive integer.` });
        }
      }
    }
  }

  const live = findings.filter((finding) => !isExcepted(validExceptions, finding));
  const current = tally(live);

  for (const [rule, files] of Object.entries(current)) {
    for (const [file, keys] of Object.entries(files)) {
      for (const [key, count] of Object.entries(keys)) {
        const allowed = debt[rule]?.[file]?.[key] ?? 0;
        if (count > allowed) {
          for (const finding of live) {
            if (finding.rule === rule && finding.file === file && finding.key === key) {
              violations.push({
                kind: "new",
                file,
                line: finding.line,
                message: `[ui/${rule}] ${finding.message}${allowed ? ` (${count} here, ${allowed} recorded as existing debt)` : ""}`,
              });
            }
          }
        }
      }
    }
  }

  const pruned = {};
  for (const [rule, files] of Object.entries(debt)) {
    for (const [file, keys] of Object.entries(files)) {
      for (const [key, allowed] of Object.entries(keys)) {
        const count = current[rule]?.[file]?.[key] ?? 0;
        if (count < allowed) {
          violations.push({
            kind: "debt-paid",
            file: DEBT_FILE,
            line: 1,
            message: `[ui/${rule}] debt paid in ${file} (${key}: ${allowed} → ${count}). Run \`pnpm check:ui --prune-debt\` so the freed budget can't be spent again.`,
          });
        }
        const kept = Math.min(count, allowed);
        if (kept > 0) {
          pruned[rule] ??= {};
          pruned[rule][file] ??= {};
          pruned[rule][file][key] = kept;
        }
      }
    }
  }
  for (const entry of validExceptions) {
    if (!findings.some((finding) => finding.rule === entry.rule && finding.file === entry.file && finding.key === entry.key)) {
      violations.push({
        kind: "stale-exception",
        file: DEBT_FILE,
        line: 1,
        message: `[ui/${entry.rule}] stale exception for ${entry.file} (${entry.key}) — it no longer matches anything; remove it.`,
      });
    }
  }
  return { violations, pruned: sortLedger(pruned), current };
}
