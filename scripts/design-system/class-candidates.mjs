// ============================================================
// class-candidates.mjs
// ------------------------------------------------------------
// Static extraction of Tailwind class candidates from renderer TS/TSX, using
// the TypeScript AST rather than line regexes. Only DEFINITE class contexts
// are read, so prose, test names, and ordinary strings never become
// candidates:
//
//   • `className` and `*ClassName` JSX attributes / object properties
//   • class helper calls: cn, clsx, cx, twMerge, twJoin
//   • cva(base, { variants, compoundVariants }) recipes
//   • `[...].join(" ")` / `[...].filter(Boolean).join(" ")` class arrays
//   • constants whose name says they hold classes (FOO_CLASS, fooClassName),
//     and the constants a class context references — block-scoped, top-level,
//     or imported by name (`cn(MENU_ITEM_RADIUS, …)`, `SIZE_CLASSES[size]`)
//
// Inside a context, the value expression is walked structurally: conditional
// branches, `||` / `??` operands, the right side of `&&`, arrays, template
// literals, string concatenation, and clsx object keys. Comparison operands
// (`variant === "ghost"`) are conditions, not classes, and are never read.
//
// A token built at an interpolation or concatenation boundary (`size-${n}`,
// "text-" + tone) is dynamic: it is skipped, and so is the expression that
// completes it. Fully static concatenations are folded first.
//
// Two outputs:
//   • occurrences — every candidate once, at its source position (for the
//     compiled-class gate and per-token policy rules)
//   • groups — the classes that land on ONE element, re-expanded at each use
//     of a shared constant, with cva variants kept apart (for pairing rules)
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";

export const CLASS_HELPERS = new Set(["cn", "clsx", "cx", "twMerge", "twJoin"]);

// `className`, `contentClassName`, `iconClassName`, … — the repo's convention
// for forwarding classes to a slot.
const CLASS_PROP_RE = /^(?:className|[a-z][A-Za-z0-9]*ClassName)$/;

// Constants that hold class strings by name (FOO_CLASS, FOO_CLASSES,
// fooClassName, …). Recipes named otherwise — MENU_SURFACE_RADIUS,
// PROMPT_SURFACE_RADIUS — are still read when a class context references them.
const CLASS_CONST_RE =
  /(?:^|_)CLASS(?:ES|NAME)?(?:_|$)|[a-z0-9](?:Class|Classes|ClassName)$/;

/** Split a class string into tokens, never splitting inside [] or (). */
export function splitClassTokens(text) {
  const tokens = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i <= text.length; i += 1) {
    const ch = text[i];
    const end = i === text.length;
    if (!end && (ch === "[" || ch === "(")) depth += 1;
    if (!end && (ch === "]" || ch === ")")) depth = Math.max(0, depth - 1);
    const boundary = end || (depth === 0 && /\s/.test(ch));
    if (boundary) {
      if (start !== -1) tokens.push({ token: text.slice(start, i), offset: start });
      start = -1;
    } else if (start === -1) {
      start = i;
    }
  }
  return tokens;
}

function scriptKind(fileName) {
  return /\.[cm]?tsx$|\.jsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

function parse(fileName, sourceText) {
  return ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, scriptKind(fileName));
}

function propertyName(name, sourceFile) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

/** Named imports: local name → { specifier, importedName }. */
function namedImports(sourceFile) {
  const out = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    const specifier = statement.moduleSpecifier.text;
    for (const element of clause.namedBindings.elements) {
      out.set(element.name.text, {
        specifier,
        importedName: (element.propertyName ?? element.name).text,
      });
    }
  }
  return out;
}

/** `const NAME = …` in one statement list. */
function constIn(statements, name) {
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const list = statement.declarationList;
    if (!(list.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of list.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        return declaration;
      }
    }
  }
  return null;
}

/** Nearest `const NAME` visible from `node` (block scopes, then the module). */
function resolveLocalConst(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (ts.isFunctionLike(scope) && scope.parameters?.some((p) => ts.isIdentifier(p.name) && p.name.text === name)) {
      return null; // a parameter shadows anything outside
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope) || ts.isDefaultClause(scope)) {
      const found = constIn(scope.statements, name);
      if (found) return found;
    }
  }
  return null;
}

const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", "/index.ts", "/index.tsx"];

/**
 * Resolve an import specifier to a source file. Handles relative paths and the
 * repository's `@/*` → `apps/desktop/src/*` alias (tsconfig.json). Packages are
 * not followed: their classes are not app markup.
 */
export function resolveModule(specifier, fromFile, root) {
  let base;
  if (specifier.startsWith("@/")) base = join(root, "apps/desktop/src", specifier.slice(2));
  else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  if (existsSync(base) && /\.[cm]?[jt]sx?$/.test(base)) return base;
  for (const extension of RESOLVE_EXTENSIONS) {
    const candidate = base + extension;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const isStringNode = (node) => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

/** The text of a fully static string expression, or null. */
function staticText(node) {
  if (isStringNode(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = left === null ? null : staticText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

/**
 * Extract class contexts from files.
 *
 * @returns {{ occurrences: Array<{file, line, column, token, group}>,
 *             groups: Map<string, {file, line, tokens: Set<string>, parent: string|null}> }}
 */
export function extractClassContexts({ files, root, read }) {
  const readSource = read ?? ((file) => readFileSync(file, "utf8"));
  const parsed = new Map();
  const load = (file) => {
    if (!parsed.has(file)) {
      let sourceFile = null;
      try {
        sourceFile = parse(file, readSource(file));
      } catch {
        sourceFile = null;
      }
      parsed.set(file, sourceFile && { sourceFile, imports: namedImports(sourceFile) });
    }
    return parsed.get(file);
  };

  const occurrences = [];
  const groups = new Map();
  const emitted = new Set();
  // Helper calls already read as part of an enclosing context (cn() inside a
  // className) are not separate elements, so they never open their own group.
  const coveredCalls = new Set();
  const callKey = (unit, node) => `${unit.sourceFile.fileName}:${node.pos}:${node.end}`;
  const tokenCache = new Map();
  let currentGroup = null;
  let activeRefs = new Set();

  const openGroup = (id, file, line, parent = null) => {
    if (!groups.has(id)) groups.set(id, { file, line, tokens: new Set(), parent });
    return id;
  };

  // Read one literal: emit its tokens once overall, and add them to the
  // current group at EVERY use (a shared constant joins each element using it).
  const useText = (unit, node, text, textStart, { trimStart, trimEnd }) => {
    const { sourceFile } = unit;
    const key = `${sourceFile.fileName}:${node.pos}:${node.end}:${node.kind}`;
    let pieces = tokenCache.get(key);
    if (!pieces) {
      const split = splitClassTokens(text);
      pieces = split
        .filter((piece, index) => {
          if (index === 0 && trimStart && piece.offset === 0) return false;
          if (index === split.length - 1 && trimEnd && piece.offset + piece.token.length === text.length) return false;
          return true;
        })
        .map((piece) => {
          const position = sourceFile.getLineAndCharacterOfPosition(textStart + piece.offset);
          return { token: piece.token, line: position.line + 1, column: position.character + 1 };
        });
      tokenCache.set(key, pieces);
    }
    if (!emitted.has(key)) {
      emitted.add(key);
      for (const piece of pieces) {
        occurrences.push({ file: sourceFile.fileName, line: piece.line, column: piece.column, token: piece.token, group: currentGroup });
      }
    }
    if (currentGroup) {
      const group = groups.get(currentGroup);
      for (const piece of pieces) group.tokens.add(piece.token);
    }
  };

  const NO_TRIM = { trimStart: false, trimEnd: false };

  // mode: "value"  — the expression evaluates to class text
  //       "clsx"   — helper argument: strings, arrays, and object KEYS
  //       "map"    — an object whose property VALUES are class text
  const visit = (unit, node, mode, depth = 0) => {
    if (!node || depth > 24) return;
    const { sourceFile } = unit;

    if (isStringNode(node)) {
      useText(unit, node, node.text, node.getStart(sourceFile) + 1, NO_TRIM);
      return;
    }

    const folded = ts.isBinaryExpression(node) ? staticText(node) : null;
    if (folded !== null) {
      // Positions inside a folded concatenation are approximate (reported at
      // the expression's first character + offset).
      useText(unit, node, folded, node.getStart(sourceFile) + 1, NO_TRIM);
      return;
    }

    if (ts.isTemplateExpression(node)) {
      const { head, templateSpans } = node;
      useText(unit, head, head.text, head.getStart(sourceFile) + 1, {
        trimStart: false,
        trimEnd: templateSpans.length > 0,
      });
      let before = head.text;
      templateSpans.forEach((span, index) => {
        const after = span.literal.text;
        // An expression flush against static text completes a partial token.
        const glued = (before !== "" && !/\s$/.test(before)) || (after !== "" && !/^\s/.test(after));
        if (!glued) visit(unit, span.expression, "value", depth + 1);
        useText(unit, span.literal, after, span.literal.getStart(sourceFile) + 1, {
          trimStart: true,
          trimEnd: index < templateSpans.length - 1,
        });
        before = after;
      });
      return;
    }

    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)) ||
      ts.isJsxExpression(node)
    ) {
      visit(unit, node.expression, mode, depth + 1);
      return;
    }

    if (ts.isConditionalExpression(node)) {
      visit(unit, node.whenTrue, mode, depth + 1);
      visit(unit, node.whenFalse, mode, depth + 1);
      return;
    }

    if (ts.isBinaryExpression(node)) {
      const operator = node.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) {
        visit(unit, node.right, mode, depth + 1);
      } else if (operator === ts.SyntaxKind.BarBarToken || operator === ts.SyntaxKind.QuestionQuestionToken) {
        visit(unit, node.left, mode, depth + 1);
        visit(unit, node.right, mode, depth + 1);
      } else if (operator === ts.SyntaxKind.PlusToken) {
        // Mixed static/dynamic concatenation (fully static was folded above).
        const leftText = staticText(node.left);
        const rightText = staticText(node.right);
        if (leftText !== null) {
          useText(unit, node.left, leftText, node.left.getStart(sourceFile) + 1, { trimStart: false, trimEnd: true });
        } else if (rightText === null || /^\s/.test(rightText)) {
          visit(unit, node.left, mode, depth + 1);
        }
        if (rightText !== null) {
          useText(unit, node.right, rightText, node.right.getStart(sourceFile) + 1, { trimStart: true, trimEnd: false });
        } else if (leftText === null || /\s$/.test(leftText)) {
          visit(unit, node.right, mode, depth + 1);
        }
      }
      return;
    }

    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) visit(unit, element, mode === "map" ? "value" : mode, depth + 1);
      return;
    }

    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (mode === "clsx") {
          // clsx({ "bg-x": cond }) — the KEYS are classes.
          if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name && isStringNode(property.name)) {
            visit(unit, property.name, "value", depth + 1);
          }
        } else if (ts.isPropertyAssignment(property)) {
          visit(unit, property.initializer, mode === "map" ? "map" : "value", depth + 1);
        }
      }
      return;
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const calleeText = callee.getText(sourceFile);
      coveredCalls.add(callKey(unit, node));
      if (CLASS_HELPERS.has(calleeText)) {
        for (const argument of node.arguments) visit(unit, argument, "clsx", depth + 1);
      } else if (calleeText === "cva") {
        visitCva(unit, node, depth + 1);
      } else if (ts.isPropertyAccessExpression(callee) && callee.name.text === "join") {
        // ["a", cond && "b"].join(" ") and [...].filter(Boolean).join(" ")
        let list = callee.expression;
        if (ts.isCallExpression(list) && ts.isPropertyAccessExpression(list.expression) && list.expression.name.text === "filter") {
          list = list.expression.expression;
        }
        if (ts.isArrayLiteralExpression(list)) visit(unit, list, "value", depth + 1);
      }
      return;
    }

    if (ts.isIdentifier(node)) {
      visitReference(unit, node, mode === "clsx" ? "value" : mode, depth + 1);
      return;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      // `SIZE_CLASSES[size]`, `chip.cls`, `STATUS[s].className` — follow the
      // access path, so `chip.cls` reads each entry's `cls`, never its label.
      const { root: object, path } = accessPath(node);
      if (ts.isIdentifier(object)) visitPath(unit, object, path, depth + 1);
    }
  };

  /** `a[k].b` → { root: a, path: [{ any: true }, { name: "b" }] } */
  const accessPath = (node) => {
    const path = [];
    let object = node;
    while (ts.isPropertyAccessExpression(object) || ts.isElementAccessExpression(object)) {
      if (ts.isPropertyAccessExpression(object)) {
        path.unshift({ name: object.name.text });
      } else {
        const argument = object.argumentExpression;
        path.unshift(argument && isStringNode(argument) ? { name: argument.text } : { any: true });
      }
      object = object.expression;
    }
    return { root: object, path };
  };

  const resolveIdentifier = (unit, identifier) => {
    const local = resolveLocalConst(identifier, identifier.text);
    if (local) return { unit, declaration: local };
    const imported = unit.imports.get(identifier.text);
    if (!imported) return null;
    const target = resolveModule(imported.specifier, unit.sourceFile.fileName, root);
    const targetUnit = target && load(target);
    const declaration = targetUnit && constIn(targetUnit.sourceFile.statements, imported.importedName);
    return declaration ? { unit: targetUnit, declaration } : null;
  };

  const visitPath = (unit, identifier, path, depth) => {
    const resolved = resolveIdentifier(unit, identifier);
    if (!resolved) return;
    const key = `${resolved.unit.sourceFile.fileName}:${resolved.declaration.pos}:${JSON.stringify(path)}`;
    if (activeRefs.has(key)) return;
    activeRefs.add(key);
    applyPath(resolved.unit, resolved.declaration.initializer, path, depth);
    activeRefs.delete(key);
  };

  // Walk `path` through object/array literals and const references; the value
  // at the end of the path is class text.
  const applyPath = (unit, node, path, depth) => {
    if (!node || depth > 24) return;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(node)) || ts.isNonNullExpression(node)) {
      node = node.expression;
    }
    if (path.length === 0) {
      visit(unit, node, "value", depth + 1);
      return;
    }
    const [step, ...rest] = path;
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        if (step.any || propertyName(property.name, unit.sourceFile) === step.name) {
          applyPath(unit, property.initializer, rest, depth + 1);
        }
      }
    } else if (ts.isArrayLiteralExpression(node) && step.any) {
      for (const element of node.elements) applyPath(unit, element, rest, depth + 1);
    } else if (ts.isConditionalExpression(node)) {
      applyPath(unit, node.whenTrue, path, depth + 1);
      applyPath(unit, node.whenFalse, path, depth + 1);
    } else if (ts.isIdentifier(node)) {
      visitPath(unit, node, path, depth + 1);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const inner = accessPath(node);
      if (ts.isIdentifier(inner.root)) visitPath(unit, inner.root, [...inner.path, ...path], depth + 1);
    }
  };

  const visitReference = (unit, identifier, mode, depth) => {
    const local = resolveLocalConst(identifier, identifier.text);
    if (local) {
      followDeclaration(unit, local, mode, depth);
      return;
    }
    const imported = unit.imports.get(identifier.text);
    if (!imported) return;
    const target = resolveModule(imported.specifier, unit.sourceFile.fileName, root);
    const targetUnit = target && load(target);
    if (!targetUnit) return;
    const declaration = constIn(targetUnit.sourceFile.statements, imported.importedName);
    if (declaration) followDeclaration(targetUnit, declaration, mode, depth);
  };

  // Guard against reference cycles (const A = cn(B); const B = cn(A)).
  const followDeclaration = (unit, declaration, mode, depth) => {
    const key = `${unit.sourceFile.fileName}:${declaration.pos}`;
    if (activeRefs.has(key)) return;
    activeRefs.add(key);
    visit(unit, declaration.initializer, mode, depth);
    activeRefs.delete(key);
  };

  const visitCva = (unit, call, depth) => {
    const [base, config] = call.arguments;
    // Base classes join every variant; each variant option and compound entry
    // is its own child group, so mutually exclusive options never pair.
    const baseGroup = currentGroup;
    visit(unit, base, "clsx", depth);
    if (!config || !ts.isObjectLiteralExpression(config)) return;
    const child = (suffix, node) => {
      if (!baseGroup) return null;
      const { line } = unit.sourceFile.getLineAndCharacterOfPosition(node.getStart(unit.sourceFile));
      return openGroup(`${baseGroup}>${suffix}`, unit.sourceFile.fileName, line + 1, baseGroup);
    };
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = propertyName(property.name, unit.sourceFile);
      if (key === "variants" && ts.isObjectLiteralExpression(property.initializer)) {
        for (const variant of property.initializer.properties) {
          if (!ts.isPropertyAssignment(variant) || !ts.isObjectLiteralExpression(variant.initializer)) continue;
          const variantName = propertyName(variant.name, unit.sourceFile);
          for (const option of variant.initializer.properties) {
            if (!ts.isPropertyAssignment(option)) continue;
            currentGroup = child(`${variantName}=${propertyName(option.name, unit.sourceFile)}`, option) ?? baseGroup;
            visit(unit, option.initializer, "clsx", depth);
            currentGroup = baseGroup;
          }
        }
      } else if (key === "compoundVariants" && ts.isArrayLiteralExpression(property.initializer)) {
        property.initializer.elements.forEach((compound, index) => {
          if (!ts.isObjectLiteralExpression(compound)) return;
          for (const entry of compound.properties) {
            if (!ts.isPropertyAssignment(entry)) continue;
            const entryKey = propertyName(entry.name, unit.sourceFile);
            if (entryKey === "class" || entryKey === "className") {
              currentGroup = child(`compound#${index}`, compound) ?? baseGroup;
              visit(unit, entry.initializer, "clsx", depth);
              currentGroup = baseGroup;
            }
          }
        });
      }
    }
  };

  /** Context roots: each opens the group of classes that land on one element. */
  const scanContexts = (unit) => {
    const { sourceFile } = unit;
    const startRoot = (node, run) => {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      currentGroup = openGroup(`${sourceFile.fileName}:${node.pos}:${node.kind}`, sourceFile.fileName, line + 1);
      activeRefs = new Set();
      run();
      currentGroup = null;
    };
    const walk = (node) => {
      if (ts.isJsxAttribute(node)) {
        if (CLASS_PROP_RE.test(propertyName(node.name, sourceFile)) && node.initializer) {
          startRoot(node, () => visit(unit, node.initializer, "value"));
        }
      } else if (ts.isCallExpression(node)) {
        const callee = node.expression.getText(sourceFile);
        if ((CLASS_HELPERS.has(callee) || callee === "cva") && !coveredCalls.has(callKey(unit, node))) {
          startRoot(node, () => visit(unit, node, "value"));
        }
      } else if (ts.isPropertyAssignment(node)) {
        if (CLASS_PROP_RE.test(propertyName(node.name, sourceFile))) {
          startRoot(node, () => visit(unit, node.initializer, "value"));
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (CLASS_CONST_RE.test(node.name.text)) {
          startRoot(node, () => visit(unit, node.initializer, "map"));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(sourceFile);
  };

  for (const file of files) {
    const unit = load(file);
    if (unit) scanContexts(unit);
  }
  return { occurrences, groups };
}

/** Candidate occurrences only (each literal once, at its source position). */
export function extractClassCandidates(options) {
  return extractClassContexts(options).occurrences;
}
