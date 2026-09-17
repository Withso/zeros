import { GitError } from "../git";
import { DESIGN_SELECTION_NODE_LIMIT } from "@zeros/protocol/design-runtime";

export function hasAsciiControl(
  value: string,
  allowTextWhitespace = false,
): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 127) return true;
    if (
      code < 32 &&
      (!allowTextWhitespace || (code !== 9 && code !== 10 && code !== 13))
    ) {
      return true;
    }
  }
  return false;
}

export function designSelectionStrings(
  value: unknown,
  label: string,
  limit: number,
  maxLength: number,
  keepMostSpecific = false,
): string[] {
  if (!Array.isArray(value) || (!keepMostSpecific && value.length > limit)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label} must be an array of at most ${limit} strings`,
    });
  }
  const candidates = keepMostSpecific ? value.slice(-limit) : value;
  const strings = candidates.filter(
    (item): item is string =>
      typeof item === "string" &&
      item.length > 0 &&
      item.trim().length > 0 &&
      item.length <= maxLength &&
      !hasAsciiControl(item),
  );
  if (strings.length !== candidates.length) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `${label} contains an invalid string`,
    });
  }
  return strings;
}

export function designSelectionRects(
  value: unknown,
): Array<{ x: number; y: number; width: number; height: number }> {
  if (!Array.isArray(value) || value.length > DESIGN_SELECTION_NODE_LIMIT) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: `rects must be an array of at most ${DESIGN_SELECTION_NODE_LIMIT} rectangles`,
    });
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "rects contains an invalid rectangle",
      });
    }
    const rect = item as Record<string, unknown>;
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (
      !values.every(
        (entry) => typeof entry === "number" && Number.isFinite(entry),
      ) ||
      (rect.width as number) < 0 ||
      (rect.height as number) < 0
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "rects contains non-finite or negative geometry",
      });
    }
    return {
      x: rect.x as number,
      y: rect.y as number,
      width: rect.width as number,
      height: rect.height as number,
    };
  });
}

export function designSelectionStyles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value);
  if (entries.length > 64) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "keyComputedStyles contains too many properties",
    });
  }
  const styles: Record<string, string> = {};
  for (const [key, item] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(key) ||
      typeof item !== "string" ||
      item.length > 512 ||
      hasAsciiControl(item, true)
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "keyComputedStyles contains an invalid property",
      });
    }
    styles[key] = item;
  }
  return styles;
}

export function designMatchedDeclarations(value: unknown): Array<{
  property: string;
  value: string;
  important?: boolean;
  selector?: string;
  sourceFile?: string;
  sourceLine?: number;
  inherited?: boolean;
  active?: boolean;
}> {
  if (!Array.isArray(value) || value.length > 256) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "matched must contain at most 256 declarations",
    });
  }
  return value.map((candidate) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "matched contains an invalid declaration",
      });
    }
    const declaration = candidate as Record<string, unknown>;
    const property = declaration.property;
    const declarationValue = declaration.value;
    if (
      typeof property !== "string" ||
      property.length > 128 ||
      !/^(?:--[A-Za-z0-9_-]+|-?[a-z][a-z0-9-]*)$/.test(property) ||
      typeof declarationValue !== "string" ||
      declarationValue.length > 2_048 ||
      hasAsciiControl(declarationValue, true)
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "matched contains an invalid declaration",
      });
    }
    const optionalString = (key: "selector" | "sourceFile", max: number) => {
      const item = declaration[key];
      if (item === undefined) return undefined;
      if (
        typeof item !== "string" ||
        item.length < 1 ||
        item.length > max ||
        hasAsciiControl(item, true)
      ) {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `matched contains an invalid ${key}`,
        });
      }
      return item;
    };
    const optionalBoolean = (key: "important" | "inherited" | "active") => {
      const item = declaration[key];
      if (item === undefined) return undefined;
      if (typeof item !== "boolean") {
        throw new GitError({
          code: "VALIDATION_FAILED",
          message: `matched contains an invalid ${key}`,
        });
      }
      return item;
    };
    const sourceLine = declaration.sourceLine;
    if (
      sourceLine !== undefined &&
      (!Number.isSafeInteger(sourceLine) || (sourceLine as number) < 1)
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "matched contains an invalid sourceLine",
      });
    }
    const selector = optionalString("selector", 1_024);
    const sourceFile = optionalString("sourceFile", 512);
    const important = optionalBoolean("important");
    const inherited = optionalBoolean("inherited");
    const active = optionalBoolean("active");
    return {
      property,
      value: declarationValue,
      ...(selector ? { selector } : {}),
      ...(sourceFile ? { sourceFile } : {}),
      ...(sourceLine !== undefined ? { sourceLine: sourceLine as number } : {}),
      ...(important !== undefined ? { important } : {}),
      ...(inherited !== undefined ? { inherited } : {}),
      ...(active !== undefined ? { active } : {}),
    };
  });
}

export function designMutationStyles(
  value: unknown,
): Record<string, string | null> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "styles must be an object",
    });
  }
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 64) {
    throw new GitError({
      code: "VALIDATION_FAILED",
      message: "styles must contain between 1 and 64 properties",
    });
  }
  const styles: Record<string, string | null> = {};
  for (const [property, item] of entries) {
    if (
      property.length === 0 ||
      property.length > 128 ||
      (typeof item !== "string" && item !== null) ||
      (typeof item === "string" &&
        (item.length > 2_048 || hasAsciiControl(item, true)))
    ) {
      throw new GitError({
        code: "VALIDATION_FAILED",
        message: "styles contains an invalid property or value",
      });
    }
    styles[property] = item;
  }
  return styles;
}
