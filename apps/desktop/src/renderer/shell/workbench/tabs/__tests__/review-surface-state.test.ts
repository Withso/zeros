// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReviewHostUnavailable, reviewSurfaceState } from "../review-surface-state";

describe("Review tab body", () => {
  const base = { discovering: false, remoteHost: "github.com", hasProvider: true, hasPullRequest: true };

  it("waits for discovery, then reviews a GitHub pull request", () => {
    expect(reviewSurfaceState({ ...base, discovering: true })).toBe("discovering");
    expect(reviewSurfaceState(base)).toBe("review");
    expect(reviewSurfaceState({ ...base, hasPullRequest: false })).toBe("no-pr");
  });

  it("names another host before saying there is no pull request", () => {
    const other = { ...base, remoteHost: "gitlab.example.com", hasProvider: false };
    expect(reviewSurfaceState({ ...other, hasPullRequest: false })).toBe("other-host");
    expect(reviewSurfaceState(other)).toBe("other-host");
  });

  it("treats an unknown remote as GitHub, never as another host", () => {
    expect(reviewSurfaceState({ ...base, remoteHost: null })).toBe("review");
    expect(reviewSurfaceState({ ...base, remoteHost: null, hasPullRequest: false })).toBe("no-pr");
  });
});

describe("another host's empty state", () => {
  let root: Root;
  let host: HTMLDivElement;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("says which host it is and opens that host's repository page", async () => {
    await act(async () =>
      root.render(createElement(ReviewHostUnavailable, { host: "gitlab.example.com", url: "https://gitlab.example.com/team/api" })),
    );
    expect(host.textContent).toContain("Reviews aren’t available for this host yet");
    expect(host.textContent).toContain("This remote is gitlab.example.com; Zeros reviews GitHub today.");
    const link = host.querySelector("a")!;
    expect(link.textContent).toBe("Open gitlab.example.com");
    expect(link.getAttribute("href")).toBe("https://gitlab.example.com/team/api");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("offers no link when the remote has no web page", async () => {
    await act(async () => root.render(createElement(ReviewHostUnavailable, { host: "git.internal", url: null })));
    expect(host.querySelector("a")).toBeNull();
  });
});
