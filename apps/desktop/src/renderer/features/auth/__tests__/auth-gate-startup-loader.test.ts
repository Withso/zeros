import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  status: "loading" as "loading" | "authenticated" | "unauthenticated",
}));

vi.mock("../use-auth", () => ({
  useAuth: () => auth,
}));

vi.mock("../login-screen", () => ({
  LoginScreen: () => null,
}));

import { AuthGate } from "../auth-gate";

describe("AuthGate startup loader", () => {
  afterEach(() => {
    auth.status = "loading";
    vi.unstubAllGlobals();
  });

  it("keeps the HTML-owned logo instead of mounting a second loader", () => {
    const getElementById = vi.fn((id: string) =>
      id === "zeros-boot" ? { remove: vi.fn() } : null,
    );
    vi.stubGlobal("document", { getElementById });

    const markup = renderToStaticMarkup(
      createElement(AuthGate, null, createElement("main", null, "app")),
    );

    expect(markup).toBe("");
    expect(getElementById).toHaveBeenCalledWith("zeros-boot");
  });

  it("recovers with the same logo if a React-only remount has no HTML loader", () => {
    vi.stubGlobal("document", { getElementById: () => null });

    const markup = renderToStaticMarkup(
      createElement(AuthGate, null, createElement("main", null, "app")),
    );

    expect(markup).toContain('id="zeros-boot"');
    expect(markup).toContain('class="zeros-boot-logo"');
    expect(markup).toContain('class="zeros-boot-halftone"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain("zeros-boot-ascii");
    expect(markup).not.toContain("Starting Zeros");
    expect(
      markup.match(/class="zeros-boot-halftone-layer /g),
    ).toHaveLength(5);
    expect(markup.replace(/<[^>]+>/g, "").trim()).toBe("");
  });
});
