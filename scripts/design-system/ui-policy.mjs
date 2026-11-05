// ============================================================
// ui-policy.mjs
// ------------------------------------------------------------
// Design-system policy for renderer class markup, enforced with a ratchet.
//
// Each rule inspects the class candidates extracted from the TypeScript AST
// (class-candidates.mjs), the JSX element tree or, for selection-edge, the
// renderer's stylesheets, and names a finding by (rule, file, key). Existing findings are recorded as DEBT in
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
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

import {
  CLASS_CONST_RE,
  CLASS_HELPERS,
  CLASS_PROP_RE,
  extractClassContexts,
  splitClassTokens,
} from "./class-candidates.mjs";

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

// What marks a chosen tab, segment, toggle, option or row. A checked form
// control (data-[state=checked], aria-checked) is its own indicator, and
// keyboard focus is the one ring, so neither counts as selection here.
const SELECTION_VARIANT_RE =
  /(?:^|:)(?:group-|peer-)?(?:aria-(?:pressed|selected|current)|aria-\[(?:pressed|selected|current)=[^\]]+\]|data-\[state=(?:active|on)\]|data-\[(?:selected|active|current)(?:=[^\]]+)?\]|data-(?:selected|active|current))(?:\/[\w-]+)?:/;

/** The edge a utility draws, or null: border colours, rings, shadows and
 * outlines. Utilities that remove an edge (border-transparent, ring-0,
 * shadow-none, outline-none) and border widths or styles draw none. */
export function edgeUtility(base) {
  const border = base.match(/^border-[xytrblse]-(.+)$/) ?? base.match(/^border-(.+)$/);
  if (border) {
    const value = border[1];
    if (/^(?:\d+(?:\.\d+)?|\[[\d.]+px\]|solid|dashed|dotted|double|hidden|none|transparent)$/.test(value)) {
      return null;
    }
    return base;
  }
  const ring = base.match(/^(?:inset-)?ring(?:-(.+))?$/);
  if (ring) return ring[1] === "0" ? null : base;
  const shadow = base.match(/^(?:inset-)?shadow(?:-(.+))?$/);
  if (shadow) return shadow[1] === "none" ? null : base;
  const outline = base.match(/^outline(?:-(.+))?$/);
  if (outline) return /^(?:none|hidden|0|offset-.+)$/.test(outline[1] ?? "") ? null : base;
  return null;
}

const SELECTION_EDGE_MESSAGE = (key) =>
  `"${key}" draws an edge on a selected, pressed, active or current state. Selection is a fill and never an edge: use the primitive's state (bg-selected-bg, var(--selected-bg)) and keep the resting edge unchanged (docs/design-system.md).`;

// The CSS half of selection-edge: a rule whose element is selected, pressed,
// active or current (not a child of one) must not draw an edge.
const CSS_SELECTION_ATTR =
  /\[(?:aria-(?:pressed|selected)="true"|aria-current(?:="[^"]*")?|data-state="(?:active|on)")\]/;
const CSS_EDGE_PROPERTY =
  /^\s*(border(?:-(?:top|right|bottom|left|block|inline)(?:-(?:start|end))?)?(?:-color)?|box-shadow|outline(?:-color)?)\s*:\s*([\s\S]+?)\s*$/;

/** [{ line, key }] for every edge a CSS selection rule declares. */
export function findCssSelectionEdges(source) {
  // Blank comments out, keeping line breaks so line numbers hold.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const findings = [];
  const block = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = block.exec(text))) {
    const [whole, selectorText, body] = match;
    const selected = selectorText
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => {
        const own = selector.split(/[\s>~+]+/).filter(Boolean).pop() ?? "";
        return CSS_SELECTION_ATTR.test(own) && !/:focus/.test(own);
      });
    if (selected.length === 0) continue;
    let offset = match.index + whole.indexOf("{") + 1;
    for (const declaration of body.split(";")) {
      const edge = declaration.match(CSS_EDGE_PROPERTY);
      if (edge) {
        const [, property, value] = edge;
        const removes =
          /^(?:none|0|transparent|hidden)$/.test(value) ||
          (property.startsWith("border") && /\btransparent\b/.test(value));
        if (!removes) {
          const line = text.slice(0, offset + declaration.search(/\S/)).split("\n").length;
          findings.push({ line, key: `${selected[0]} { ${property} }` });
        }
      }
      offset += declaration.length + 1;
    }
  }
  return findings;
}

// The conditional half of selection-edge: classes a selection condition adds,
// as in `selected && "ring-2"` or `tab === activeTab ? "border-border4" : …`.
// A flag names the state itself; a comparison names the chosen value.
// dragActive (a drop target) and canConfigureActive are neither.
const SELECTION_FLAG_RE = /^(?:is)?(?:[Ss]elected|[Aa]ctive|[Pp]ressed|[Cc]urrent|[Cc]hosen)$/;
const SELECTION_VALUE_RE = /^(?:is)?(?:[Ss]elected|[Aa]ctive|[Cc]urrent|[Cc]hosen)(?:[A-Z_]\w*)?$/;

function conditionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isCallExpression(node)) return conditionName(node.expression);
  return null;
}

/** `{ name, negated }` when the condition tests a selection, else null. */
function selectionCondition(node) {
  if (ts.isParenthesizedExpression(node)) return selectionCondition(node.expression);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = selectionCondition(node.operand);
    return inner && { name: inner.name, negated: !inner.negated };
  }
  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
      // `selected && !disabled` is still the selected state; a negated half
      // leaves the other branch ambiguous.
      const sides = [selectionCondition(node.left), selectionCondition(node.right)];
      return sides.find((side) => side && !side.negated) ?? null;
    }
    const equal =
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken || operator === ts.SyntaxKind.EqualsEqualsToken;
    const unequal =
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken || operator === ts.SyntaxKind.ExclamationEqualsToken;
    if (!equal && !unequal) return null;
    const name = [node.left, node.right].map(conditionName).find((side) => side && SELECTION_VALUE_RE.test(side));
    return name ? { name, negated: unequal } : null;
  }
  const name = conditionName(node);
  return name && SELECTION_FLAG_RE.test(name) ? { name, negated: false } : null;
}

/** True when a literal reaches a class: a className prop, a class helper
 * call or a class constant, as class-candidates.mjs reads them. */
function inClassContext(node, sourceFile) {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (ts.isJsxAttribute(cursor)) return CLASS_PROP_RE.test(cursor.name.getText(sourceFile));
    if (ts.isPropertyAssignment(cursor) && CLASS_PROP_RE.test(cursor.name.getText(sourceFile))) return true;
    if (ts.isCallExpression(cursor)) {
      const callee = cursor.expression.getText(sourceFile);
      if (CLASS_HELPERS.has(callee) || callee === "cva") return true;
    }
    if (ts.isVariableDeclaration(cursor) && ts.isIdentifier(cursor.name)) {
      return CLASS_CONST_RE.test(cursor.name.text);
    }
  }
  return false;
}

function literalTexts(node, out = []) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node);
  else if (ts.isTemplateExpression(node)) {
    out.push(node.head, ...node.templateSpans.map((span) => span.literal));
    for (const span of node.templateSpans) literalTexts(span.expression, out);
  } else ts.forEachChild(node, (child) => literalTexts(child, out));
  return out;
}

/** [{ line, key }] for every edge a selection condition adds to a class. A
 * border in the box's own fill colour (a checked box) and keyboard focus
 * draw no selection edge. */
export function findConditionalSelectionEdges(file, source) {
  const kind = /\.[cm]?tsx$|\.jsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const findings = [];
  const visit = (node) => {
    let condition = null;
    let branch = null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      condition = selectionCondition(node.left);
      if (condition && !condition.negated) branch = node.right;
    } else if (ts.isConditionalExpression(node)) {
      condition = selectionCondition(node.condition);
      if (condition) branch = condition.negated ? node.whenFalse : node.whenTrue;
    }
    if (branch) {
      for (const literal of literalTexts(branch)) {
        if (!inClassContext(literal, sourceFile)) continue;
        const tokens = splitClassTokens(literal.text).map(({ token }) => token);
        const fills = new Set(
          tokens.map(baseUtility).filter((base) => base.startsWith("bg-")).map((base) => base.slice(3)),
        );
        for (const token of tokens) {
          const base = baseUtility(token);
          if (/focus/.test(token.slice(0, token.length - base.length)) || !edgeUtility(base)) continue;
          const border = base.match(/^border-(?:[xytrblse]-)?(.+)$/);
          if (border && fills.has(border[1])) continue;
          const { line } = sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile));
          findings.push({ line: line + 1, key: `${condition.name}: ${token}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

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
    id: "selection-edge",
    message: (key) => SELECTION_EDGE_MESSAGE(key),
    test(base, token) {
      const variants = token.slice(0, token.length - base.length);
      if (!SELECTION_VARIANT_RE.test(variants) || /focus/.test(variants)) return null;
      return edgeUtility(base) ? token : null;
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
  "icon-only-button",
  "class-template-join",
  "ignore-directive",
]);

const RAW_CONTROL_TAGS = new Set(["button", "input", "select", "textarea"]);

export const RAW_CONTROL_RULE = {
  id: "raw-control",
  message: (key) =>
    `Raw <${key}> outside shared/ui. Use the shared primitive (Button, Input, Select, Textarea, Checkbox, …) so size, focus, and states stay consistent; extend the primitive if it lacks a variant.`,
};

export const ICON_ONLY_BUTTON_RULE = {
  id: "icon-only-button",
  message: () =>
    "A quiet icon-only action is an IconButton: its required `label` is the accessible name, and it owns the hover, focus ring and glyph size. Filled or bordered icon buttons stay Buttons.",
};

const ICON_SIZES = /^icon(?:-sm|-lg|-compact)?$/;

/** `<Button variant="ghost" size="icon…">`: the IconButton job done by hand. */
export function findIconOnlyButtons(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const literal = (node, name) => {
    for (const attribute of node.attributes.properties) {
      if (
        ts.isJsxAttribute(attribute) &&
        attribute.name.getText(sourceFile) === name &&
        attribute.initializer &&
        ts.isStringLiteral(attribute.initializer)
      ) {
        return attribute.initializer.text;
      }
    }
    return null;
  };
  const visit = (node) => {
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === "Button" &&
      literal(node, "variant") === "ghost" &&
      ICON_SIZES.test(literal(node, "size") ?? "")
    ) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      findings.push({ key: "Button size=icon", line: line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

export const CLASS_TEMPLATE_JOIN_RULE = {
  id: "class-template-join",
  message: () =>
    "A className template joins a class to an interpolation with no space, so both tokens break (`relative${drag ? \"ring-2\" : \"\"}` renders `relativering-2`). Compose classes with cn().",
};

/** `className={`a b${x}`}` or `${x}b`: text touching an interpolation. */
export function findClassTemplateJoins(file, source) {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings = [];
  const visit = (node) => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(sourceFile) === "className" &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression &&
      ts.isTemplateExpression(node.initializer.expression)
    ) {
      const template = node.initializer.expression;
      const texts = [template.head.text, ...template.templateSpans.map((span) => span.literal.text)];
      // Text before an interpolation must end in whitespace (or be empty);
      // text after one must start with whitespace (or be empty).
      const joined = texts.some((text, index) =>
        (index < texts.length - 1 && /\S$/.test(text)) || (index > 0 && /^\S/.test(text)),
      );
      if (joined) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        findings.push({ key: "className", line: line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

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

/** Stylesheets under a directory, for the CSS half of the rules. */
function cssFilesUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : cssFilesUnder(path);
    return entry.name.endsWith(".css") ? [path] : [];
  });
}

/**
 * All policy findings: [{ rule, file, key, line, message }]. `cssFiles`
 * defaults to the renderer's stylesheets.
 */
export function collectFindings({ root, files, contexts, cssFiles }) {
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

  for (const file of cssFiles ?? cssFilesUnder(join(root, "apps/desktop/src/renderer"))) {
    const rel = toRel(root, file);
    if (!isPolicyScoped(rel)) continue;
    for (const finding of findCssSelectionEdges(readFileSync(file, "utf8"))) {
      findings.push({
        rule: "selection-edge",
        file: rel,
        key: finding.key,
        line: finding.line,
        message: SELECTION_EDGE_MESSAGE(finding.key),
      });
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
    const rel = toRel(root, file);
    const source = readFileSync(file, "utf8");
    for (const finding of findConditionalSelectionEdges(file, source)) {
      findings.push({
        rule: "selection-edge",
        file: rel,
        key: finding.key,
        line: finding.line,
        message: SELECTION_EDGE_MESSAGE(finding.key),
      });
    }
    if (!file.endsWith(".tsx")) continue;
    for (const finding of findClassTemplateJoins(file, source)) {
      findings.push({
        rule: CLASS_TEMPLATE_JOIN_RULE.id,
        file: rel,
        key: finding.key,
        line: finding.line,
        message: CLASS_TEMPLATE_JOIN_RULE.message(),
      });
    }
    if (rel.startsWith("apps/desktop/src/renderer/shared/ui/")) continue;
    for (const finding of findRawControls(file, source)) {
      findings.push({
        rule: RAW_CONTROL_RULE.id,
        file: rel,
        key: finding.key,
        line: finding.line,
        message: RAW_CONTROL_RULE.message(finding.key),
      });
    }
    for (const finding of findIconOnlyButtons(file, source)) {
      findings.push({
        rule: ICON_ONLY_BUTTON_RULE.id,
        file: rel,
        key: finding.key,
        line: finding.line,
        message: ICON_ONLY_BUTTON_RULE.message(),
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
