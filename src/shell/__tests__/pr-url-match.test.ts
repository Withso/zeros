import { describe, it, expect } from "vitest";
import { isActivePrUrl, parsePrUrl } from "../pr/pr-url-match";

const PR_URL = "https://github.com/Acme/Widgets/pull/13";

describe("parsePrUrl", () => {
  it("parses a plain PR link", () => {
    expect(parsePrUrl(PR_URL)).toEqual({
      owner: "acme",
      repo: "widgets",
      number: 13,
    });
  });

  it("tolerates www., suffix paths, query, and hash", () => {
    for (const url of [
      "https://www.github.com/Acme/Widgets/pull/13",
      "https://github.com/Acme/Widgets/pull/13/files",
      "https://github.com/Acme/Widgets/pull/13/checks?check_run_id=9",
      "https://github.com/Acme/Widgets/pull/13#issuecomment-1",
      "https://github.com/Acme/Widgets/pull/13/",
    ]) {
      expect(parsePrUrl(url)?.number).toBe(13);
    }
  });

  it("rejects non-PR URLs", () => {
    for (const url of [
      "https://github.com/Acme/Widgets/issues/13",
      "https://github.com/Acme/Widgets",
      "https://gitlab.com/Acme/Widgets/pull/13",
      "https://github.com/Acme/Widgets/pull/abc",
      "not a url",
      "src/app/index.html",
    ]) {
      expect(parsePrUrl(url)).toBeNull();
    }
  });
});

describe("isActivePrUrl", () => {
  it("matches the active PR (same repo + number), any casing/suffix", () => {
    expect(isActivePrUrl(PR_URL, PR_URL, 13)).toBe(true);
    expect(
      isActivePrUrl("https://github.com/acme/WIDGETS/pull/13/files", PR_URL, 13),
    ).toBe(true);
  });

  it("rejects a different PR number or repo", () => {
    expect(isActivePrUrl("https://github.com/Acme/Widgets/pull/14", PR_URL, 13)).toBe(false);
    expect(isActivePrUrl("https://github.com/acme/example/pull/13", PR_URL, 13)).toBe(false);
  });

  it("falls back to number-only matching when prUrl is not yet synced", () => {
    expect(isActivePrUrl(PR_URL, null, 13)).toBe(true);
    expect(isActivePrUrl(PR_URL, null, 12)).toBe(false);
  });
});
