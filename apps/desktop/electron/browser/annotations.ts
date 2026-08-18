import { isBrowserElementRef } from "@zeros/protocol/browser-tools";

import { browserError } from "./errors";

export interface BrowserAnnotation {
  ref: string;
  label: string;
}

export function parseBrowserAnnotations(value: unknown): BrowserAnnotation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw browserError("Browser annotations must be an array.");
  }
  if (value.length > 20) {
    throw browserError("A browser screenshot supports at most 20 annotations.");
  }
  return value.map((candidate, index) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw browserError("Browser annotation must be an object.");
    }
    const record = candidate as Record<string, unknown>;
    if (!isBrowserElementRef(record.ref)) {
      throw browserError("Browser annotation ref is invalid.");
    }
    if (
      record.label !== undefined &&
      (typeof record.label !== "string" || record.label.trim().length > 80)
    ) {
      throw browserError(
        "Browser annotation label must be at most 80 characters.",
      );
    }
    return {
      ref: record.ref,
      label:
        typeof record.label === "string" && record.label.trim()
          ? record.label.trim().replace(/\s+/g, " ")
          : String(index + 1),
    };
  });
}
