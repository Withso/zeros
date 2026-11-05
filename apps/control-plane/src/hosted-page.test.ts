import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { HOSTED_PAGE_STYLE_SOURCE, hostedPage } from "./hosted-page.js";

const BEGIN = "// BEGIN shared hosted-page shell";
const END = "// END shared hosted-page shell\n";

function sharedRegion(source: string): string {
  const begin = source.indexOf(BEGIN);
  const end = source.indexOf(END);
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return source.slice(begin, end + END.length);
}

describe("hosted page shell", () => {
  it("is the web app's page shell, copied verbatim", async () => {
    const control = await readFile(new URL("./hosted-page.ts", import.meta.url), "utf8");
    const web = await readFile(new URL("../../web/lib/page.ts", import.meta.url), "utf8");

    expect(sharedRegion(control)).toBe(sharedRegion(web));
  });

  it("draws the logo and mark inline, with the extra head tags", () => {
    const page = hostedPage(
      "Completing sign in",
      '<div class="title">Completing sign in</div>',
      '<meta name="referrer" content="no-referrer" />',
    );

    expect(page).toContain('<meta name="referrer" content="no-referrer" />');
    expect(page).toMatch(/<a class="brand" href="\/" aria-label="Zeros home"><svg class="brand-mark"/);
    expect(page).toMatch(/<svg class="hero-logo"[^>]*>.*<\/svg><div class="title">Completing sign in<\/div>/);
    expect(page).not.toContain("<img ");
  });

  it("names the exact inline stylesheet in its CSP hash", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(hostedPage("Title", ""))?.[1] ?? "";

    expect(HOSTED_PAGE_STYLE_SOURCE).toBe(
      `'sha256-${createHash("sha256").update(style).digest("base64")}'`,
    );
  });
});
