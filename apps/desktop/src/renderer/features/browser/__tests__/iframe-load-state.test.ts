import { describe, expect, it } from "vitest";
import {
  patchIframeWebviewState,
  type IframeWebviewState,
} from "../use-iframe-webview";

const confirmed: IframeWebviewState = {
  currentUrl: "https://example.test/old",
  loadedUrl: "https://example.test/old",
  title: "Confirmed preview",
  faviconDataUrl: null,
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  loadError: "Previous preview failed",
};

describe("iframe load state ownership", () => {
  it("clears an old URL's error when another URL starts loading", () => {
    const next = patchIframeWebviewState(confirmed, {
      currentUrl: "https://example.test/new",
      isLoading: true,
    });
    expect(next.loadError).toBeNull();
    expect(next.loadedUrl).toBe(confirmed.loadedUrl);
  });
  it("retains the same URL's failure and confirmed snapshot during retry", () => {
    const next = patchIframeWebviewState(confirmed, {
      currentUrl: confirmed.currentUrl,
      isLoading: true,
    });
    expect(next.loadError).toBe(confirmed.loadError);
    expect(next.loadedUrl).toBe(confirmed.loadedUrl);
  });
  it("accepts an explicit error for the new URL", () => {
    expect(
      patchIframeWebviewState(confirmed, {
        currentUrl: "https://example.test/new",
        loadError: "New preview failed",
      }).loadError,
    ).toBe("New preview failed");
  });
});
