import { beforeEach, describe, expect, it } from "vitest";

import {
  clearPreviewNavigationsForTest,
  consumePreviewNavigation,
  isPreviewRuntimeUrlForTab,
  previewNavigationForTab,
  previewRuntimeOriginForTab,
  previewRuntimeStateForTab,
  redactPreviewRuntimeTextForTab,
  stagePreviewNavigation,
  takePreviewNavigation,
} from "../../browser/preview-navigation";

describe("ephemeral preview navigation", () => {
  beforeEach(clearPreviewNavigationsForTest);
  it("keeps native header admission outside the persisted logical URL", () => {
    const url = "http://localhost:5173/assets?version=2";
    const admissionUrl = "https://preview.example.test/assets?version=2";
    stagePreviewNavigation("browser-native", { url, admissionUrl, expiresAt: Date.now() + 60_000, native: true });
    expect(previewNavigationForTab("browser-native", url)).toBe(admissionUrl);
    expect(isPreviewRuntimeUrlForTab("browser-native", url, admissionUrl)).toBe(true);
    expect(url).not.toContain("preview.example.test");
    expect(() => stagePreviewNavigation("browser-native-invalid", { url, admissionUrl: "http://preview.example.test/", native: true })).toThrow("capability");
  });

  it("keeps the one-use admission URL out of persisted tab state", () => {
    const persisted = "http://127.0.0.1:45678/";
    const admission = `${persisted}?__zsr_cap=secret`;
    stagePreviewNavigation("browser-1", {
      url: persisted,
      admissionUrl: admission,
    });
    expect(takePreviewNavigation("browser-1", persisted)).toBe(admission);
    expect(takePreviewNavigation("browser-1", persisted)).toBeNull();
    expect(persisted).not.toContain("secret");
  });

  it("keeps a signed cloud hostname volatile behind a localhost display URL", () => {
    const persisted = "http://localhost:5173/";
    const admission =
      "https://41000-provider-secret.preview.example/?__zsr_cap=inner-secret";
    const expiresAt = Date.now() + 30 * 60_000;
    stagePreviewNavigation("browser-cloud", {
      url: persisted,
      admissionUrl: admission,
      expiresAt,
    });
    expect(previewNavigationForTab("browser-cloud", persisted)).toBe(admission);
    expect(
      previewRuntimeOriginForTab("browser-cloud", persisted),
    ).toBe("https://41000-provider-secret.preview.example");
    expect(previewRuntimeStateForTab("browser-cloud", persisted)).toEqual({
      origin: "https://41000-provider-secret.preview.example",
      expiresAt,
      volatileOrigin: true,
    });
    expect(
      isPreviewRuntimeUrlForTab(
        "browser-cloud",
        persisted,
        "https://41000-provider-secret.preview.example/app/dashboard",
      ),
    ).toBe(true);
    expect(
      redactPreviewRuntimeTextForTab(
        "browser-cloud",
        persisted,
        "41000-provider-secret.preview.example — Vite",
      ),
    ).toBe("localhost:5173 — Vite");
    consumePreviewNavigation("browser-cloud");
    expect(previewNavigationForTab("browser-cloud", persisted)).toBe(
      "https://41000-provider-secret.preview.example/",
    );
    expect(persisted).not.toContain("provider-secret");
  });

  it("rejects a cross-origin admission without a localhost logical URL", () => {
    expect(() =>
      stagePreviewNavigation("browser-1", {
        url: "https://untrusted.example/",
        admissionUrl: "https://preview.example/?__zsr_cap=secret",
      }),
    ).toThrow("logical URL");
  });

  it("rejects expired or implausibly long preview authorizations", () => {
    const now = Date.now();
    for (const expiresAt of [
      now - 1,
      now + 24 * 60 * 60_000 + 2 * 60_000,
      Number.NaN,
    ]) {
      expect(() =>
        stagePreviewNavigation("browser-expiry", {
          url: "http://localhost:5173/",
          admissionUrl:
            "https://41000-provider-secret.preview.example/?__zsr_cap=secret",
          expiresAt,
        }),
      ).toThrow(/expiry/i);
    }
  });
});
