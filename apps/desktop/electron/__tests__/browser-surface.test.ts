import { describe, expect, it, vi } from "vitest";
import { Script } from "node:vm";

import {
  browserActionLabel,
  browserAgentPointerOverlayScript,
  browserFaviconNavigationDisposition,
  browserFaviconFallbackNeeded,
  browserAgentNavigationDisposition,
  browserInputDisposition,
  browserElementActionLabel,
  browserNavigationPublishStatus,
  browserOperationNeedsReadySettlement,
  browserServiceInvocationBlockedReason,
  browserRendererEventIsCurrent,
  browserAgentActionStillOwnsPage,
  browserAgentWorkingOverlayScript,
  cancelBrowserTitleCandidate,
  commitBrowserTitleCandidate,
  browserInputTargetStillMatches,
  browserDomMarkers,
  browserPolicySnapshotIsCurrent,
  browserSessionShouldRemainAlive,
  browserSurfaceShouldBeVisible,
  browserSurfaceHoverAfterAttach,
  browserSurfaceCaptureDataUrl,
  browserSurfaceDetachAllowed,
  browserViewportAfterExplicitResize,
  browserViewportForAttachedBounds,
  browserViewportPresentation,
  normalizeBrowserViewBounds,
  normalizeBrowserViewBoundsForHost,
  normalizeCodexPageNavigateResult,
  queueBrowserTitleCandidate,
  shouldRevokeBrowserSurfaceForNavigation,
  usableBrowserDocument,
  createSharedBrowserWaiter,
  dispatchBrowserUserNavigation,
  fetchBrowserFaviconDataUrl,
  normalizedBrowserFaviconMime,
  orderedBrowserFaviconCandidates,
  safeBrowserSvgFavicon,
} from "../browser/surface";
import { canonicalBrowserOriginGrantKey } from "@zeros/protocol/browser-tools";

describe("Zeros native browser surface", () => {
  it("retains native hover across PiP resize but clears it when rehosted", () => {
    expect(browserSurfaceHoverAfterAttach(false, true)).toBe(true);
    expect(browserSurfaceHoverAfterAttach(true, true)).toBe(false);
  });

  it("renders a compact black agent arrow with white and violet-blue glow", () => {
    const script = browserAgentPointerOverlayScript(
      "__zeros-agent-pointer-0123456789abcdef01234567",
      { x: 120, y: 80, action: "click", updatedAt: 1 },
    );

    expect(script).toContain('fill="#050505"');
    expect(script).toContain('stroke="#fff"');
    expect(script).toContain('width="16"');
    expect(script).toContain('height="18"');
    expect(script).toContain('stroke-width="1.35"');
    expect(script).toContain('const version = "compact-v2"');
    expect(script).toContain("root.remove()");
    expect(script).toContain("rgba(103,80,255");
    expect(script).not.toContain("border:2px solid rgba(41,190,235");
    expect(script).toContain("pointer-events:none");
    expect(() => new Script(script)).not.toThrow();
  });

  it("fits PiP as a scaled desktop viewport while normal tabs stay 1:1", () => {
    expect(
      browserViewportPresentation(
        { x: 0, y: 0, width: 800, height: 556 },
        { width: 1_440, height: 1_000 },
        true,
      ),
    ).toEqual({
      viewport: { width: 1_440, height: 1_000 },
      zoomFactor: 5 / 9,
    });
    expect(
      browserViewportPresentation(
        { x: 0, y: 0, width: 800, height: 556 },
        { width: 1_440, height: 1_000 },
        false,
      ),
    ).toEqual({
      viewport: { width: 800, height: 556 },
      zoomFactor: 1,
    });
  });

  it("coalesces only the apex/www variant of an official Browser origin grant", () => {
    expect(canonicalBrowserOriginGrantKey("https://sarvam.ai")).toBe(
      "https://sarvam.ai",
    );
    expect(canonicalBrowserOriginGrantKey("https://www.sarvam.ai")).toBe(
      "https://sarvam.ai",
    );
    expect(canonicalBrowserOriginGrantKey("https://docs.sarvam.ai")).toBe(
      "https://docs.sarvam.ai",
    );
    expect(canonicalBrowserOriginGrantKey("http://www.sarvam.ai")).toBe(
      "http://sarvam.ai",
    );
    expect(canonicalBrowserOriginGrantKey("file:///tmp/page")).toBeNull();
  });

  it("accepts bounded SVG website icons while rejecting active SVG content", () => {
    expect(normalizedBrowserFaviconMime("image/svg+xml; charset=utf-8")).toBe(
      "image/svg+xml",
    );
    expect(normalizedBrowserFaviconMime("text/html; charset=utf-8")).toBeNull();
    expect(
      safeBrowserSvgFavicon(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>',
        ),
      ),
    ).toBe(true);
    expect(
      safeBrowserSvgFavicon(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        ),
      ),
    ).toBe(false);
    expect(
      safeBrowserSvgFavicon(
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:url(https://tracker.example/pixel)}</style><path/></svg>',
        ),
      ),
    ).toBe(false);
  });

  it("prefers page-advertised favicon artwork before generic origin fallbacks", () => {
    expect(
      orderedBrowserFaviconCandidates("https://www.sarvam.ai/developers", [
        "https://www.sarvam.ai/favicon.svg",
      ]),
    ).toEqual([
      "https://www.sarvam.ai/favicon.svg",
      "https://www.sarvam.ai/favicon.ico",
      "https://www.sarvam.ai/apple-touch-icon.png",
    ]);
  });

  it("falls back to the conventional SVG favicon when a page emits no favicon event", () => {
    expect(
      orderedBrowserFaviconCandidates("https://www.sarvam.ai/developers"),
    ).toEqual([
      "https://www.sarvam.ai/favicon.ico",
      "https://www.sarvam.ai/favicon.svg",
      "https://www.sarvam.ai/apple-touch-icon.png",
    ]);
  });

  it("accepts a favicon fetched by its validated request URL when Electron leaves Response.url blank", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      // Electron documents Response.url as incorrect for net.fetch/session.fetch.
      url: "",
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    }));

    await expect(
      fetchBrowserFaviconDataUrl({
        url: "https://example.com/favicon.png",
        pageUrl: "https://example.com/dashboard",
        fetch,
        normalizeRaster: (bytes) => bytes,
      }),
    ).resolves.toBe("data:image/png;base64,AQID");
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/favicon.png",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("resolves a relative advertised favicon against its exact page URL", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "image/png" }),
      arrayBuffer: async () => Uint8Array.from([7, 8, 9]).buffer,
    }));

    await expect(
      fetchBrowserFaviconDataUrl({
        url: "../assets/favicon.png",
        pageUrl: "https://example.com/products/detail",
        fetch,
        normalizeRaster: (bytes) => bytes,
      }),
    ).resolves.toBe("data:image/png;base64,BwgJ");
    expect(fetch).toHaveBeenCalledWith(
      "https://example.com/assets/favicon.png",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("follows only bounded HTTP(S) favicon redirects and validates SVG before decoding", async () => {
    const redirectedFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 302,
        headers: new Headers({ location: "/assets/icon.png" }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Uint8Array.from([4, 5, 6]).buffer,
      });
    await expect(
      fetchBrowserFaviconDataUrl({
        url: "https://example.com/favicon.ico",
        fetch: redirectedFetch,
        normalizeRaster: (bytes) => bytes,
      }),
    ).resolves.toBe("data:image/png;base64,BAUG");
    expect(redirectedFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/favicon.ico",
      "https://example.com/assets/icon.png",
    ]);

    const unsafeSvg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const normalizeRaster = vi.fn((bytes: Buffer) => bytes);
    await expect(
      fetchBrowserFaviconDataUrl({
        url: "https://example.com/favicon.svg",
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "image/svg+xml" }),
          arrayBuffer: async () => unsafeSvg.buffer.slice(
            unsafeSvg.byteOffset,
            unsafeSvg.byteOffset + unsafeSvg.byteLength,
          ),
        }),
        normalizeRaster,
      }),
    ).resolves.toBeNull();
    expect(normalizeRaster).not.toHaveBeenCalled();
  });

  it("retains a confirmed favicon across same-origin routes and resets it at an origin boundary", () => {
    expect(
      browserFaviconNavigationDisposition({
        currentOrigin: "https://www.sarvam.ai",
        targetUrl: "https://www.sarvam.ai/developers",
        isMainFrame: true,
        isSameDocument: false,
      }),
    ).toBe("retain");
    expect(
      browserFaviconNavigationDisposition({
        currentOrigin: "https://sarvam.ai",
        targetUrl: "https://www.sarvam.ai/",
        isMainFrame: true,
        isSameDocument: false,
      }),
    ).toBe("reset");
    expect(
      browserFaviconNavigationDisposition({
        currentOrigin: "https://www.sarvam.ai",
        targetUrl: "https://cdn.sarvam.ai/embed",
        isMainFrame: false,
        isSameDocument: false,
      }),
    ).toBe("ignore");
  });

  it("does not let a generic load fallback supersede an advertised favicon request", () => {
    expect(
      browserFaviconFallbackNeeded({
        hasFavicon: false,
        currentGeneration: 4,
        resolvingGeneration: 4,
      }),
    ).toBe(false);
    expect(
      browserFaviconFallbackNeeded({
        hasFavicon: false,
        currentGeneration: 4,
        resolvingGeneration: 3,
      }),
    ).toBe(true);
    expect(
      browserFaviconFallbackNeeded({
        hasFavicon: true,
        currentGeneration: 4,
        resolvingGeneration: null,
      }),
    ).toBe(false);
  });

  it("shares concurrent native load waits and releases the key after settlement", async () => {
    let resolve!: () => void;
    const target = {};
    const waitOnce = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const wait = createSharedBrowserWaiter(waitOnce);

    const first = wait(target);
    const second = wait(target);
    expect(first).toBe(second);
    expect(waitOnce).toHaveBeenCalledTimes(1);
    resolve();
    await first;
    await Promise.resolve();

    void wait(target);
    expect(waitOnce).toHaveBeenCalledTimes(2);
  });

  it("dispatches trusted chrome history controls synchronously without a snapshot wait", () => {
    const calls: string[] = [];
    const callbacks = {
      open: (url: string) => calls.push(`open:${url}`),
      back: () => calls.push("back"),
      forward: () => calls.push("forward"),
      reload: () => calls.push("reload"),
    };

    expect(
      dispatchBrowserUserNavigation({
        tool: "back",
        canGoBack: true,
        canGoForward: false,
        ...callbacks,
      }),
    ).toBe(true);
    expect(
      dispatchBrowserUserNavigation({
        tool: "forward",
        canGoBack: true,
        canGoForward: false,
        ...callbacks,
      }),
    ).toBe(false);
    expect(
      dispatchBrowserUserNavigation({
        tool: "open",
        url: "https://example.com/next",
        canGoBack: true,
        canGoForward: false,
        ...callbacks,
      }),
    ).toBe(true);
    expect(calls).toEqual(["back", "open:https://example.com/next"]);
  });

  it("keeps the visual working treatment out of native CDP hit testing", () => {
    const script = browserAgentWorkingOverlayScript(
      "__zeros-agent-working-0123456789abcdef01234567",
      true,
    );

    expect(script).toContain("pointer-events:none");
    expect(script).toContain("cursor:none!important");
    expect(script).not.toContain("pointer-events:auto");
    expect(script).toContain("position:fixed");
    expect(script).not.toContain("Agent working");
    expect(script).not.toContain("top:14px");
    expect(script).not.toContain("__zerosWorkingTimer");
  });

  it("treats ERR_ABORTED as a successful Page.navigate only after a usable redirect commits", () => {
    const aborted = { frameId: "frame", errorText: "net::ERR_ABORTED" };
    expect(
      normalizeCodexPageNavigateResult(aborted, {
        requestedUrl: "https://paper.design/snapshot",
        previousUrl: "https://paper.design/docs/mcp",
        currentUrl:
          "https://chromewebstore.google.com/detail/paper-snapshot/example",
        usableDocument: true,
      }),
    ).toEqual({ frameId: "frame" });
    expect(
      normalizeCodexPageNavigateResult(aborted, {
        requestedUrl: "https://paper.design/sitemap.xml",
        previousUrl: "https://paper.design/docs/mcp",
        currentUrl: "https://paper.design/docs/mcp",
        usableDocument: true,
      }),
    ).toEqual(aborted);
    expect(
      normalizeCodexPageNavigateResult(
        { frameId: "frame", errorText: "net::ERR_BLOCKED_BY_CLIENT" },
        {
          requestedUrl: "https://paper.design/sitemap.xml",
          previousUrl: "https://paper.design/docs/mcp",
          currentUrl: "https://paper.design/docs/mcp",
          usableDocument: true,
        },
      ),
    ).toEqual({ frameId: "frame", errorText: "net::ERR_BLOCKED_BY_CLIENT" });
  });

  it("keeps navigation/title events inside an in-flight agent action", () => {
    expect(
      browserNavigationPublishStatus({
        currentStatus: "working",
        activeOperations: 1,
      }),
    ).toBe("working");
    expect(
      browserNavigationPublishStatus({
        currentStatus: "ready",
        activeOperations: 0,
      }),
    ).toBe("ready");
  });

  it("commits only the latest loaded title candidate and cancels it on a new navigation", () => {
    const initial = { confirmed: "Old page", pending: null, generation: 0 };
    const hostname = queueBrowserTitleCandidate(initial, "NammaTN");
    const finalTitle = queueBrowserTitleCandidate(
      hostname,
      "Mines & minerals · NammaTN",
    );

    expect(
      commitBrowserTitleCandidate(finalTitle, hostname.generation, false),
    ).toBe(finalTitle);
    expect(
      commitBrowserTitleCandidate(finalTitle, finalTitle.generation, true),
    ).toBe(finalTitle);
    expect(
      commitBrowserTitleCandidate(finalTitle, finalTitle.generation, false),
    ).toEqual({
      confirmed: "Mines & minerals · NammaTN",
      pending: null,
      generation: finalTitle.generation,
    });
    expect(cancelBrowserTitleCandidate(finalTitle)).toEqual({
      confirmed: "Old page",
      pending: null,
      generation: finalTitle.generation + 1,
    });
  });

  it("locks direct page input for the complete agent-owned browser session", () => {
    // Ownership is turn-scoped: an idle gap between native batches is still
    // agent work, so the lock never expires on its own. Only the handoff paths
    // that publish `actor: "user"` release it.
    expect(browserInputDisposition({ actor: "agent" })).toBe("block");
    expect(
      browserInputDisposition({ actor: "agent", agentDispatched: false }),
    ).toBe("block");
    expect(browserInputDisposition({ actor: "user" })).toBe("allow");
    // Trusted input the host synthesized for the current agent action must not
    // be mistaken for user takeover by its own observer.
    expect(
      browserInputDisposition({ actor: "agent", agentDispatched: true }),
    ).toBe("allow");
  });

  it("keeps cross-site page navigation behind the website approval boundary", () => {
    const base = {
      actor: "agent" as const,
      currentOrigin: "https://example.com",
      targetOrigin: "https://accounts.example.net",
      isMainFrame: true,
      navigationApproval: "always-ask" as const,
      siteAllowed: false,
      preapprovedOrigin: null,
      officialProviderOwnsOriginApproval: false,
    };
    expect(browserAgentNavigationDisposition(base)).toBe("confirm");
    expect(
      browserAgentNavigationDisposition({
        ...base,
        preapprovedOrigin: "https://accounts.example.net",
      }),
    ).toBe("allow");
    expect(
      browserAgentNavigationDisposition({ ...base, siteAllowed: true }),
    ).toBe("allow");
    expect(
      browserAgentNavigationDisposition({
        ...base,
        navigationApproval: "always-allow",
      }),
    ).toBe("allow");
    expect(browserAgentNavigationDisposition({ ...base, actor: "user" })).toBe(
      "allow",
    );
    expect(
      browserAgentNavigationDisposition({ ...base, isMainFrame: false }),
    ).toBe("allow");
    expect(
      browserAgentNavigationDisposition({
        ...base,
        officialProviderOwnsOriginApproval: true,
      }),
    ).toBe("allow");
    expect(
      browserAgentNavigationDisposition({
        ...base,
        targetOrigin: "https://example.com",
      }),
    ).toBe("allow");
  });

  it("does not expire a visible browser surface or active operation", () => {
    expect(
      browserSessionShouldRemainAlive({
        activeOperations: 0,
        surfaceAttached: true,
      }),
    ).toBe(true);
    expect(
      browserSessionShouldRemainAlive({
        activeOperations: 1,
        surfaceAttached: false,
      }),
    ).toBe(true);
    expect(
      browserSessionShouldRemainAlive({
        activeOperations: 0,
        surfaceAttached: false,
      }),
    ).toBe(false);
  });

  it("ignores stale detach cleanup after the native page moves to another surface", () => {
    expect(browserSurfaceDetachAllowed("surface-main", "surface-main")).toBe(
      true,
    );
    expect(browserSurfaceDetachAllowed("surface-pip", "surface-main")).toBe(
      false,
    );
    expect(browserSurfaceDetachAllowed(null, "surface-main")).toBe(false);
  });

  it("keeps the live page visible while an approval card waits in chat", () => {
    expect(
      browserSurfaceShouldBeVisible({
        attachedToTrustedWindow: true,
        confirmationDepth: 1,
      }),
    ).toBe(true);
    expect(
      browserSurfaceShouldBeVisible({
        attachedToTrustedWindow: false,
        confirmationDepth: 1,
      }),
    ).toBe(false);
  });

  it("uses a bounded JPEG fallback when a lossless overlay capture is too large", () => {
    const oversizedPng = `data:image/png;base64,${"a".repeat(128)}`;
    const compactJpeg = Buffer.from("compact-overlay-capture");

    expect(
      browserSurfaceCaptureDataUrl(
        {
          toDataURL: () => oversizedPng,
          toJPEG: (quality) => {
            expect(quality).toBe(82);
            return compactJpeg;
          },
        },
        96,
      ),
    ).toBe(`data:image/jpeg;base64,${compactJpeg.toString("base64")}`);
  });

  it("fails closed when neither overlay capture encoding fits the IPC bound", () => {
    expect(
      browserSurfaceCaptureDataUrl(
        {
          toDataURL: () => `data:image/png;base64,${"a".repeat(128)}`,
          toJPEG: () => Buffer.alloc(128),
        },
        64,
      ),
    ).toBeNull();
  });

  it("publishes concise action copy without leaking typed values", () => {
    expect(browserActionLabel("snapshot", {})).toBe("Reading page…");
    expect(browserActionLabel("scroll", { y: 720 })).toBe("Scrolling down…");
    expect(
      browserActionLabel("type", { text: "super secret", ref: "b2" }),
    ).toBe("Typing…");
    expect(browserActionLabel("open", { url: "https://example.com/a" })).toBe(
      "Opening example.com…",
    );
  });

  it("enriches visible element actions with bounded accessible labels", () => {
    expect(browserElementActionLabel("click", "  Explore   grants  ")).toBe(
      "Clicking Explore grants…",
    );
    expect(browserElementActionLabel("type", "Search the site")).toBe(
      "Typing in Search the site…",
    );
    expect(browserElementActionLabel("upload", "Evidence file")).toBe(
      "Uploading to Evidence file…",
    );
    expect(browserElementActionLabel("type", " \n ")).toBe("Typing…");
    expect(
      browserElementActionLabel("click", `Start ${"x".repeat(200)}`).length,
    ).toBeLessThanOrEqual(160);
  });

  it("accepts an exact renderer-owned rectangle", () => {
    expect(
      normalizeBrowserViewBounds({ x: 24, y: 80, width: 1_200, height: 720 }),
    ).toEqual({ x: 24, y: 80, width: 1_200, height: 720 });
  });

  it.each([
    [{ x: -1, y: 0, width: 100, height: 100 }],
    [{ x: 0.5, y: 0, width: 100, height: 100 }],
    [{ x: 0, y: 0, width: 0, height: 100 }],
    [{ x: 0, y: 0, width: 10_001, height: 100 }],
    [null],
  ])("rejects unsafe native-view bounds %#", (bounds) => {
    expect(normalizeBrowserViewBounds(bounds)).toBeNull();
  });

  it("maps renderer CSS pixels through the app zoom and keeps the guest inside the window", () => {
    expect(
      normalizeBrowserViewBoundsForHost(
        { x: 100, y: 80, width: 640, height: 480 },
        1.25,
        { width: 1_200, height: 900 },
      ),
    ).toEqual({ x: 125, y: 100, width: 800, height: 600 });
    expect(
      normalizeBrowserViewBoundsForHost(
        { x: 900, y: 80, width: 640, height: 480 },
        1,
        { width: 1_200, height: 900 },
      ),
    ).toBeNull();
    expect(
      normalizeBrowserViewBoundsForHost(
        { x: 100, y: 80, width: 640, height: 480 },
        Number.NaN,
        { width: 1_200, height: 900 },
      ),
    ).toBeNull();
  });

  it("uses the measured PiP rectangle as the live browser viewport", () => {
    expect(
      browserViewportForAttachedBounds({
        x: 120,
        y: 80,
        width: 760,
        height: 468,
      }),
    ).toEqual({ width: 760, height: 468 });
    expect(
      browserViewportForAttachedBounds({
        x: 12,
        y: 40,
        width: 280,
        height: 220,
      }),
    ).toEqual({ width: 280, height: 220 });
  });

  it("does not let an explicit resize desynchronize an attached live surface", () => {
    const attached = { width: 760, height: 468 };
    const requested = { width: 1_440, height: 1_000 };
    expect(browserViewportAfterExplicitResize(attached, requested, false)).toBe(
      attached,
    );
    expect(browserViewportAfterExplicitResize(attached, requested, true)).toBe(
      requested,
    );
  });

  it("blocks host invocations after Browser use is disabled even if the engine has an old binding", () => {
    expect(
      browserServiceInvocationBlockedReason({
        browserEnabled: false,
        trustedSurfaceAvailable: true,
      }),
    ).toBe("Browser use is disabled in Settings.");
    expect(
      browserServiceInvocationBlockedReason({
        browserEnabled: true,
        trustedSurfaceAvailable: false,
      }),
    ).toBe("Open the trusted Zeros window before using browser automation.");
    expect(
      browserServiceInvocationBlockedReason({
        browserEnabled: true,
        trustedSurfaceAvailable: true,
      }),
    ).toBeNull();
  });

  it("does not move a deferred browser event across a renderer reload", () => {
    expect(
      browserRendererEventIsCurrent({
        capturedEpoch: 4,
        currentEpoch: 4,
        sameWindow: true,
      }),
    ).toBe(true);
    expect(
      browserRendererEventIsCurrent({
        capturedEpoch: 4,
        currentEpoch: 5,
        sameWindow: true,
      }),
    ).toBe(false);
    expect(
      browserRendererEventIsCurrent({
        capturedEpoch: 4,
        currentEpoch: 4,
        sameWindow: false,
      }),
    ).toBe(false);
  });

  it("revokes on a renderer document replacement, not an embedded preview navigation", () => {
    expect(
      shouldRevokeBrowserSurfaceForNavigation({
        isMainFrame: true,
        isSameDocument: false,
      }),
    ).toBe(true);
    expect(
      shouldRevokeBrowserSurfaceForNavigation({
        isMainFrame: false,
        isSameDocument: false,
      }),
    ).toBe(false);
    expect(
      shouldRevokeBrowserSurfaceForNavigation({
        isMainFrame: true,
        isSameDocument: true,
      }),
    ).toBe(false);
  });

  it("does not let an agent click or type over a direct user takeover", () => {
    expect(browserAgentActionStillOwnsPage(7, 7)).toBe(true);
    expect(browserAgentActionStillOwnsPage(7, 8)).toBe(false);
  });

  it("revalidates the exact input semantics after a confirmation pause", () => {
    const password = {
      tagName: "INPUT",
      inputType: "password",
      label: "Account password",
    };
    expect(browserInputTargetStillMatches(password, password)).toBe(true);
    expect(
      browserInputTargetStillMatches(password, {
        ...password,
        inputType: "text",
      }),
    ).toBe(false);
    expect(
      browserInputTargetStillMatches(password, {
        ...password,
        label: "Public comment",
      }),
    ).toBe(false);
    expect(
      browserInputTargetStillMatches(password, {
        ...password,
        tagName: "TEXTAREA",
      }),
    ).toBe(false);
  });

  it("does not revive an invocation queued before a disable and re-enable", () => {
    expect(browserPolicySnapshotIsCurrent(4, 4)).toBe(true);
    expect(browserPolicySnapshotIsCurrent(4, 6)).toBe(false);
  });

  it("settles a failed semantic action that returned while still marked working", () => {
    expect(browserOperationNeedsReadySettlement("working")).toBe(true);
    expect(browserOperationNeedsReadySettlement("ready")).toBe(false);
    expect(browserOperationNeedsReadySettlement("awaiting-confirmation")).toBe(
      false,
    );
    expect(browserOperationNeedsReadySettlement("closed")).toBe(false);
  });

  it("names host DOM markers with an unguessable lease token", () => {
    expect(browserDomMarkers("0123456789abcdef01234567")).toEqual({
      refAttribute: "data-zeros-browser-ref-0123456789abcdef01234567",
      refScope: "0123456789abcdef01234567",
      pointerId: "__zeros-agent-pointer-0123456789abcdef01234567",
      annotationId: "__zeros-browser-annotations-0123456789abcdef01234567",
    });
    expect(() => browserDomMarkers("predictable")).toThrow(
      "browser DOM marker token",
    );
  });

  it("accepts a usable HTTPS document after a noisy load timeout", () => {
    expect(
      usableBrowserDocument({
        url: "https://example.com/dashboard",
        readyState: "interactive",
        hasDocumentElement: true,
      }),
    ).toBe(true);
  });

  it.each([
    [{ url: "about:blank", readyState: "complete", hasDocumentElement: true }],
    [
      {
        url: "file:///tmp/page",
        readyState: "complete",
        hasDocumentElement: true,
      },
    ],
    [
      {
        url: "https://example.com",
        readyState: "loading",
        hasDocumentElement: true,
      },
    ],
    [
      {
        url: "https://example.com",
        readyState: "complete",
        hasDocumentElement: false,
      },
    ],
  ])(
    "does not mistake an unusable document for a completed load %#",
    (state) => {
      expect(usableBrowserDocument(state)).toBe(false);
    },
  );
});
