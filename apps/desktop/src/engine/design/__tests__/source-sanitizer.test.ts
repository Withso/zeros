import { describe, expect, it } from "vitest";
import { sanitizeDesignFrameMarkup } from "../document";
import { withDesignTheme } from "../source";

describe("authored render source sanitization", () => {
  it("preserves following content when an active container has nested active attributes", () => {
    const source =
      '<html><body><object><a href="javascript:alert(1)">hidden</a></object><main data-oid="retained">Visible content</main></body></html>';
    expect(sanitizeDesignFrameMarkup(source)).toBe(
      '<html><body><main data-oid="retained">Visible content</main></body></html>',
    );
  });
  it("handles deeply nested generated markup without exhausting the JavaScript stack", () => {
    const source =
      "<div>".repeat(6_000) +
      '<a onclick="alert(1)">Text</a>' +
      "</div>".repeat(6_000);
    expect(sanitizeDesignFrameMarkup(source)).toBe(
      source.replace(' onclick="alert(1)"', ""),
    );
  });
});

describe("frame theme selection", () => {
  it("sets the theme on the html element the way the canvas Themes control does", () => {
    expect(withDesignTheme('<!doctype html><html lang="en"><body></body></html>', "light")).toBe(
      '<!doctype html><html data-zd-theme="light" lang="en"><body></body></html>',
    );
    expect(withDesignTheme("<!DOCTYPE html><HTML><body></body></HTML>", "light")).toBe(
      '<!DOCTYPE html><HTML data-zd-theme="light"><body></body></HTML>',
    );
  });
  it("replaces an authored theme and adds an html tag when the frame has none", () => {
    expect(withDesignTheme("<html data-zd-theme='dark'><body></body></html>", "light")).toBe(
      '<html data-zd-theme="light"><body></body></html>',
    );
    expect(withDesignTheme("<!doctype html><main>Home</main>", "light")).toBe(
      '<!doctype html><html data-zd-theme="light"><main>Home</main>',
    );
  });
  it("refuses names the canvas cannot select", () => {
    expect(() => withDesignTheme("<html></html>", '"><script>')).toThrow(/theme/);
  });
});
