import { describe, expect, it } from "vitest";

import {
  isLoopbackHost,
  isLoopbackUrl,
  looksLikeBrowserUrl,
  normalizeBrowserUrl,
} from "../localhost-url";

describe("normalizeBrowserUrl", () => {
  it("preserves explicit http(s) pages and allows external sites", () => {
    expect(normalizeBrowserUrl("https://example.com/docs?q=1#api")).toBe(
      "https://example.com/docs?q=1#api",
    );
    expect(normalizeBrowserUrl("http://example.com")).toBe(
      "http://example.com/",
    );
  });

  it("defaults public hosts to https and loopback hosts to http", () => {
    expect(normalizeBrowserUrl("example.com/docs")).toBe(
      "https://example.com/docs",
    );
    expect(normalizeBrowserUrl("localhost:3000/dashboard")).toBe(
      "http://localhost:3000/dashboard",
    );
    expect(normalizeBrowserUrl("127.0.0.2:8080")).toBe(
      "http://127.0.0.2:8080/",
    );
    expect(normalizeBrowserUrl("[::1]:5173/app")).toBe("http://[::1]:5173/app");
  });

  it("rejects empty, malformed, credentialed, and non-web URLs", () => {
    for (const value of [
      "",
      "   ",
      "https://",
      "http://example.com:bad",
      "https://user:secret@example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,hello",
    ]) {
      expect(normalizeBrowserUrl(value)).toBeNull();
    }
  });
});

describe("looksLikeBrowserUrl", () => {
  it("recognizes explicit URLs, hosts, loopback ports, and IPs", () => {
    for (const value of [
      "https://example.com",
      "example.com/docs",
      "localhost:3000",
      "app.localhost:5173",
      "127.0.0.1:8080",
      "[::1]:3000",
    ]) {
      expect(looksLikeBrowserUrl(value)).toBe(true);
    }
  });

  it("keeps plain words and file-like searches out of direct URL results", () => {
    for (const value of ["browser", "App.tsx", "src/app", "component snap"])
      expect(looksLikeBrowserUrl(value)).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("accepts the loopback family", () => {
    for (const host of [
      "localhost",
      "LOCALHOST",
      "app.localhost",
      "0.0.0.0",
      "::1",
      "[::1]",
      "127.0.0.1",
      "127.1.2.3",
    ]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("rejects external, LAN, malformed, and look-alike hosts", () => {
    for (const host of [
      "google.com",
      "localhostevil.com",
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "127.0.0.999",
      "192.168.1.5",
      "10.0.0.1",
      "example.localhost.com",
      "app.local",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("isLoopbackUrl", () => {
  it("accepts http(s) loopback URLs on any port/path", () => {
    expect(isLoopbackUrl("http://localhost:3000")).toBe(true);
    expect(isLoopbackUrl("https://localhost")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:8080/x?y=1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:5173")).toBe(true);
    expect(isLoopbackUrl("http://0.0.0.0:3000")).toBe(true);
    expect(isLoopbackUrl("http://app.localhost:3000/dash")).toBe(true);
  });

  it("rejects external hosts, non-http schemes, LAN hosts, and junk", () => {
    expect(isLoopbackUrl("https://google.com")).toBe(false);
    expect(isLoopbackUrl("http://localhostevil.com")).toBe(false);
    expect(isLoopbackUrl("http://192.168.0.10:3000")).toBe(false);
    expect(isLoopbackUrl("data:text/html,hi")).toBe(false);
    expect(isLoopbackUrl("about:blank")).toBe(false);
    expect(isLoopbackUrl("file:///etc/passwd")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
