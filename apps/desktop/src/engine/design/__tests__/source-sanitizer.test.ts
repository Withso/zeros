import { describe, expect, it } from "vitest";
import { sanitizeDesignFrameMarkup } from "../document";

describe("authored render source sanitization", () => {
  it("preserves following content when an active container has nested active attributes", () => {
    const source =
      '<html><body><object><a href="javascript:alert(1)">hidden</a></object><main data-oid="retained">Visible content</main></body></html>';
    expect(sanitizeDesignFrameMarkup(source)).toBe(
      '<html><body><main data-oid="retained">Visible content</main></body></html>',
    );
  });
  it("handles deeply nested generated markup without exhausting the JavaScript stack", () => {
    const source =
      "<div>".repeat(6_000) +
      '<a onclick="alert(1)">Text</a>' +
      "</div>".repeat(6_000);
    expect(sanitizeDesignFrameMarkup(source)).toBe(
      source.replace(' onclick="alert(1)"', ""),
    );
  });
});
