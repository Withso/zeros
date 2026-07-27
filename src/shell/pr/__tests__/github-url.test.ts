import { describe, it, expect } from "vitest";

import { githubCompareUrl, parseRemote } from "../github-url";

describe("parseRemote", () => {
  it("parses scp-style SSH remotes", () => {
    expect(parseRemote("git@github.com:acme/example.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "example",
    });
  });

  it("parses HTTPS remotes with and without .git", () => {
    expect(parseRemote("https://github.com/acme/example")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "example",
    });
    expect(parseRemote("https://github.com/acme/example.git")).toEqual({
      host: "github.com",
      owner: "acme",
      repo: "example",
    });
  });

  it("parses ssh:// URLs and GitHub Enterprise hosts", () => {
    expect(parseRemote("ssh://git@ghe.corp.dev/team/app.git")).toEqual({
      host: "ghe.corp.dev",
      owner: "team",
      repo: "app",
    });
  });

  it("returns null for junk / empty / non-repo input", () => {
    expect(parseRemote(null)).toBeNull();
    expect(parseRemote("")).toBeNull();
    expect(parseRemote("not a url")).toBeNull();
  });
});

describe("githubCompareUrl", () => {
  it("builds a compare URL with expand=1", () => {
    expect(
      githubCompareUrl("git@github.com:acme/example.git", "main", "zeros/foo"),
    ).toBe("https://github.com/acme/example/compare/main...zeros/foo?expand=1");
  });

  it("preserves branch slashes but encodes unsafe chars", () => {
    const url = githubCompareUrl(
      "https://github.com/o/r",
      "main",
      "feat/a b",
    );
    expect(url).toBe("https://github.com/o/r/compare/main...feat/a%20b?expand=1");
  });

  it("returns null when the remote can't be parsed", () => {
    expect(githubCompareUrl("weird", "main", "x")).toBeNull();
    expect(githubCompareUrl(null, "main", "x")).toBeNull();
  });
});
