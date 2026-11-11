import { describe, expect, it, vi } from "vitest";

import { designTextStyles, designTokenCatalog } from "../design-token-catalog";
import { designTextStyleStyles } from "../design-typography-editor";

vi.stubGlobal("CSS", { supports: () => false });

const token = (name: string, value: string) => ({ name, value, themeValues: {} });

describe("applying a text style", () => {
  const catalog = designTokenCatalog({
    manual: [],
    sources: [
      {
        id: "app",
        title: "App",
        kind: "css",
        path: "app.css",
        status: "ready",
        messages: [],
        themes: [],
        tokens: [
          token("--text-xs", "13px"),
          token("--text-xs--line-height", "calc(18 / 13)"),
          token("--text-heading-lg", "28px"),
          token("--text-heading-lg--line-height", "36px"),
          token("--text-heading-lg--letter-spacing", "-0.02em"),
          token("--text-heading-lg--font-weight", "600"),
        ],
        bytes: 0,
        revision: null,
      },
    ],
    theme: null,
  });
  const [xs, heading] = designTextStyles(catalog);

  it("writes its size and only the parts it declares, as tokens", () => {
    expect(designTextStyleStyles(xs!)).toEqual({
      "font-size": "var(--text-xs)",
      "line-height": "var(--text-xs--line-height)",
    });
    expect(designTextStyleStyles(heading!)).toEqual({
      "font-size": "var(--text-heading-lg)",
      "line-height": "var(--text-heading-lg--line-height)",
      "letter-spacing": "var(--text-heading-lg--letter-spacing)",
      "font-weight": "var(--text-heading-lg--font-weight)",
    });
  });
});
