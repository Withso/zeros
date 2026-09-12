import { describe, expect, it } from "vitest";

import { repoPathOverlapsDesignRoot } from "../path-authority";

describe("Design path authority", () => {
  it("matches case and Unicode aliases on case-insensitive hosts", () => {
    expect(
      repoPathOverlapsDesignRoot("zeros design/frame.html", "Zeros Design", {
        caseInsensitive: true,
      }),
    ).toBe(true);
    expect(
      repoPathOverlapsDesignRoot("Cafe\u0301 Design/frame.html", "Caf\u00e9 Design", {
        caseInsensitive: true,
      }),
    ).toBe(true);
  });

  it("keeps byte-distinct paths separate on case-sensitive hosts", () => {
    expect(
      repoPathOverlapsDesignRoot("zeros design/frame.html", "Zeros Design", {
        caseInsensitive: false,
      }),
    ).toBe(false);
  });
});
