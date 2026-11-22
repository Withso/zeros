import { chromium } from "@playwright/test";
import { expect, it } from "vitest";

import { CSS_SHORTHAND_LONGHANDS } from "@zeros/design-core/css-longhands";

// The static table stands in for the browser where there is no DOM (the
// engine's lint); it must expand each shorthand exactly as Chromium does.
it("expands every shorthand in the table to exactly the longhands Chromium sets", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const actual = await page.evaluate((names) => Object.fromEntries(names.map((name) => {
      const probe = document.createElement("div").style;
      probe.setProperty(name, "inherit");
      const longhands: string[] = [];
      for (let index = 0; index < probe.length; index += 1) if (probe[index] !== name) longhands.push(probe[index]!);
      return [name, longhands.sort()];
    })), Object.keys(CSS_SHORTHAND_LONGHANDS));
    const expected = Object.fromEntries(Object.entries(CSS_SHORTHAND_LONGHANDS).map(([name, longhands]) => [name, [...longhands].sort()]));
    expect(actual).toEqual(expected);
  } finally {
    await browser.close();
  }
}, 30_000);
