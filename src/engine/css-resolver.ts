// ──────────────────────────────────────────────────────────
// CSS Source Resolver — Find where a CSS selector lives on disk
// ──────────────────────────────────────────────────────────
//
// V2: Uses the EngineCache selector index for O(1) lookup,
// then reads the file to locate the specific property within
// the matched rule block.
//
// Ported from extensions/vscode/src/css-source-resolver.ts
// with vscode.workspace.findFiles() replaced by cache.
//
// ──────────────────────────────────────────────────────────

import * as path from "node:path";
import type { EngineCache, SourceLocation } from "./cache";

export class CSSResolver {
  constructor(
    private root: string,
    private cache: EngineCache
  ) {}

  /**
   * Find the source location where a CSS selector declares a property.
   * Returns null if not found.
   */
  async resolve(
    selector: string,
    property: string
  ): Promise<SourceLocation | null> {
    const kebabProperty = toKebabCase(property);
    const variants = selectorVariants(selector);

    for (const variant of variants) {
      // O(1) cache lookup
      const locations = this.cache.resolveSelector(variant);
      if (!locations) continue;

      for (const loc of locations) {
        // Read the file and find the property in the rule block
        const content = this.cache.readFile(loc.file);
        if (!content) continue;

        const lines = content.split("\n");
        const propertyLine = findPropertyInBlock(lines, loc.line - 1, kebabProperty);
        if (propertyLine !== null) {
          return {
            file: loc.file,
            relPath: path.relative(this.root, loc.file),
            line: propertyLine + 1, // 1-based
            column: lines[propertyLine].search(/\S/),
            selector: variant,
          };
        }
      }
    }

    return null;
  }
}

// ── Helpers (ported verbatim from VS Code extension) ─────

/**
 * Generate selector variants to match against the index.
 * E.g., "button.primary" → ["button.primary", ".primary", "button"]
 */
function selectorVariants(selector: string): string[] {
  const variants: string[] = [selector];

  // Extract class names
  const classMatch = selector.match(/\.[\w-]+/g);
  if (classMatch) {
    for (const cls of classMatch) {
      if (!variants.includes(cls)) variants.push(cls);
    }
  }

  // Extract tag name
  const tagMatch = selector.match(/^(\w[\w-]*)/);
  if (tagMatch && tagMatch[1] !== selector) {
    variants.push(tagMatch[1]);
  }

  // Extract ID
  const idMatch = selector.match(/#[\w-]+/);
  if (idMatch) {
    variants.push(idMatch[0]);
  }

  return variants;
}

/**
 * Starting from a line with `{`, find a property declaration inside the block.
 * Tracks brace depth so we don't leak into nested rules.
 */
function findPropertyInBlock(
  lines: string[],
  startLine: number,
  property: string
): number | null {
  let depth = 0;
  let started = false;

  // Walk forward from the selector line to find the opening brace
  let braceStart = startLine;
  while (braceStart < lines.length && !lines[braceStart].includes("{")) {
    braceStart++;
  }
  if (braceStart >= lines.length) return null;

  for (let i = braceStart; i < lines.length; i++) {
    const line = lines[i];

    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      }
      if (ch === "}") depth--;
    }

    // We're inside the top-level block (depth === 1) when looking for properties
    if (started && depth === 1) {
      const trimmed = line.trim();
      const propRegex = new RegExp(
        `^\\s*${escapeForRegex(property)}\\s*:`
      );
      if (propRegex.test(trimmed) || propRegex.test(line)) {
        return i;
      }
    }

    // Block closed
    if (started && depth <= 0) break;
  }

  return null;
}

function toKebabCase(str: string): string {
  return str.replace(/([A-Z])/g, "-$1").toLowerCase();
}

function escapeForRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
