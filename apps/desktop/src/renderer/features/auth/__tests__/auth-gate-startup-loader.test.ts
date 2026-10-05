import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  status: "loading" as "loading" | "authenticated" | "unauthenticated",
  local: false,
}));

vi.mock("../../../platform/runtime", () => ({ isLocalDevelopment: () => auth.local }));

vi.mock("../use-auth", () => ({
  useAuth: () => auth,
}));

vi.mock("../login-screen", () => ({
  LoginScreen: () => null,
}));

import { AuthGate } from "../auth-gate";

/** The text a user would actually read, via a real HTML parse. Stripping tags
 *  with `replace(/<[^>]+>/g, "")` is an incomplete sanitizer (CodeQL
 *  js/incomplete-multi-character-sanitization) and genuinely wrong here: an
 *  unterminated `<script src=x` or a `>` inside an attribute value survives
 *  the pass and reappears as "text". Parsing has neither blind spot. */
const visibleText = (markup: string) => {
  const text: string[] = [];
  const visit = (node: DefaultTreeAdapterTypes.Node) => {
    // `in`, not `nodeName === "#text"`: parse5 types Element.nodeName as a
    // plain string, so the literal never narrows. Only TextNode has `value`
    // (a comment carries `data`), which is the check document.ts already uses.
    if ("value" in node) text.push(node.value);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  parseFragment(markup).childNodes.forEach(visit);
  return text.join("").trim();
};

describe("AuthGate startup loader", () => {
  afterEach(() => {
    auth.status = "loading";
    auth.local = false;
    vi.unstubAllGlobals();
  });

  it("opens the real shell in native Local without inventing an authenticated account", () => {
    auth.local = true;
    auth.status = "unauthenticated";
    const markup = renderToStaticMarkup(createElement(AuthGate, null, createElement("main", null, "app")));
    expect(markup).toBe("<main>app</main>");
  });

  it("keeps ordinary Dev and packaged signed-out users behind login", () => {
    auth.status = "unauthenticated";
    expect(renderToStaticMarkup(createElement(AuthGate, null, createElement("main", null, "app")))).not.toContain("<main>");
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
    expect(markup.match(/class="zeros-boot-halftone-layer /g)).toHaveLength(5);
    expect(visibleText(markup)).toBe("");
  });
});
