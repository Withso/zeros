import { describe, expect, it } from "vitest";

import {
  declaredIframeFaviconUrls,
  iframeFaviconNavigationDisposition,
  resolveIframeFaviconCandidates,
} from "../iframe-favicon";

describe("ordinary Browser iframe favicon resolution", () => {
  it("keeps only bounded http(s) candidates and resolves relative page declarations", () => {
    expect(
      resolveIframeFaviconCandidates("https://openai.com/research/", [
        "../favicon.svg",
        "https://cdn.example/openai-icon.png",
        "javascript:alert(1)",
        "data:image/png;base64,AAAA",
      ]),
    ).toEqual([
      "https://openai.com/favicon.svg",
      "https://cdn.example/openai-icon.png",
      "https://openai.com/favicon.ico",
      "https://openai.com/apple-touch-icon.png",
    ]);
  });

  it("bounds page-declared icon metadata before main fetches it", async () => {
    await expect(
      declaredIframeFaviconUrls(async () => [
        "/one.svg",
        "/two.png",
        42,
        "/three.ico",
        "/four.png",
        "/ignored.png",
      ]),
    ).resolves.toEqual([
      "/one.svg",
      "/two.png",
      "/three.ico",
      "/four.png",
    ]);
  });

  it("retains artwork for same-origin route changes and clears it before cross-origin loads", () => {
    expect(
      iframeFaviconNavigationDisposition(
        "https://openai.com/research/",
        "https://openai.com/index/chatgpt/",
      ),
    ).toBe("retain");
    expect(
      iframeFaviconNavigationDisposition(
        "https://openai.com/research/",
        "https://vercel.com/docs",
      ),
    ).toBe("reset");
    expect(
      iframeFaviconNavigationDisposition(
        "https://openai.com/research/",
        "file:///tmp/nope",
      ),
    ).toBe("reset");
  });
});
