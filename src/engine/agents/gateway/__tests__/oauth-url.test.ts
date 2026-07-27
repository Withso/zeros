import { describe, it, expect } from "vitest";

import {
  UnsafeAuthUrlError,
  assertSafeAuthUrl,
  canonicalResourceUri,
  isLoopbackHost,
  isReservedIpLiteral,
  issuerMismatchReason,
  parseAuthorizationCode,
  unsafeAuthUrlReason,
} from "../oauth-url";

describe("parseAuthorizationCode (headless paste)", () => {
  it("extracts code + state from a full redirect URL", () => {
    expect(
      parseAuthorizationCode("http://127.0.0.1:24302/callback?code=abc123&state=xyz"),
    ).toEqual({ code: "abc123", state: "xyz" });
  });
  it("extracts code from a bare query string", () => {
    expect(parseAuthorizationCode("code=abc&state=s")).toEqual({ code: "abc", state: "s" });
    expect(parseAuthorizationCode("?code=abc")).toEqual({ code: "abc", state: undefined });
  });
  it("treats a bare token as the code", () => {
    expect(parseAuthorizationCode("  just-the-code  ")).toEqual({ code: "just-the-code" });
  });
  it("throws when a URL has no code", () => {
    expect(() => parseAuthorizationCode("https://x/callback?error=denied")).toThrow(/no \?code=/i);
  });
});

describe("issuerMismatchReason (mix-up / issuer binding)", () => {
  it("accepts an issuer that matches the AS URL (trailing slash + default port ignored)", () => {
    expect(issuerMismatchReason("https://auth.example.com", "https://auth.example.com")).toBeNull();
    expect(issuerMismatchReason("https://auth.example.com/", "https://auth.example.com")).toBeNull();
    expect(issuerMismatchReason("https://auth.example.com:443", "https://auth.example.com")).toBeNull();
    expect(issuerMismatchReason("https://auth.example.com/tenant", "https://auth.example.com/tenant/")).toBeNull();
  });
  it("rejects a different host / scheme / path (mix-up)", () => {
    expect(issuerMismatchReason("https://evil.example.com", "https://auth.example.com")).toMatch(/mix-up/i);
    expect(issuerMismatchReason("http://auth.example.com", "https://auth.example.com")).toMatch(/mix-up/i);
    expect(issuerMismatchReason("https://auth.example.com/other", "https://auth.example.com/tenant")).toMatch(/mix-up/i);
  });
  it("rejects an unparseable URL", () => {
    expect(issuerMismatchReason("not a url", "https://auth.example.com")).toMatch(/not a valid/i);
  });
});

describe("canonicalResourceUri (RFC 8707)", () => {
  it("lowercases scheme+host, drops the default port, strips a trailing slash, preserves path case", () => {
    expect(canonicalResourceUri("HTTPS://MCP.Example.COM:443/MCP/")).toBe("https://mcp.example.com/MCP");
    expect(canonicalResourceUri("https://mcp.example.com")).toBe("https://mcp.example.com");
    expect(canonicalResourceUri("https://mcp.example.com/")).toBe("https://mcp.example.com");
  });

  it("keeps a non-default port and drops the fragment + userinfo", () => {
    expect(canonicalResourceUri("https://mcp.example.com:8443/mcp#frag")).toBe("https://mcp.example.com:8443/mcp");
    expect(canonicalResourceUri("https://user:pass@mcp.example.com/mcp")).toBe("https://mcp.example.com/mcp");
  });

  it("the Fabric URL canonicalizes stably", () => {
    expect(canonicalResourceUri("https://mcp.api.fabric.so/mcp")).toBe("https://mcp.api.fabric.so/mcp");
  });

  it("throws on garbage", () => {
    expect(() => canonicalResourceUri("not a url")).toThrow();
  });
});

describe("unsafeAuthUrlReason / assertSafeAuthUrl — SSRF + scheme guard", () => {
  const reason = (u: string, allowLoopback = false) => unsafeAuthUrlReason(u, { allowLoopback });

  it("allows a public https URL", () => {
    expect(reason("https://auth.example.com/authorize")).toBeNull();
    expect(reason("https://8.8.8.8/x")).toBeNull(); // public IP, https
    expect(assertSafeAuthUrl("https://auth.example.com").href).toBe("https://auth.example.com/");
  });

  it("rejects http on a non-loopback host, and non-http(s) schemes", () => {
    expect(reason("http://auth.example.com")).toMatch(/http/i);
    expect(reason("ftp://auth.example.com")).toMatch(/scheme/i);
    expect(reason("file:///etc/passwd")).toMatch(/scheme/i);
    expect(reason("not-a-url")).toMatch(/valid/i);
  });

  it("blocks cloud-metadata + private + link-local + loopback IPv4 literals (SSRF)", () => {
    for (const u of [
      "https://169.254.169.254/latest/meta-data/", // AWS/GCP metadata — the classic SSRF target
      "https://10.0.0.5/x",
      "https://172.16.0.1/x",
      "https://172.31.255.255/x",
      "https://192.168.1.1/x",
      "https://127.0.0.1/x",
      "https://100.64.0.1/x", // CGNAT
      "https://0.0.0.0/x",
    ]) {
      expect(reason(u)).toMatch(/SSRF|private|reserved|loopback/i);
    }
  });

  it("catches IPv4 written in decimal/hex (the URL parser normalizes to dotted-quad)", () => {
    // 2130706433 === 127.0.0.1 ; 0x7f000001 === 127.0.0.1 — both normalize via WHATWG URL.
    expect(reason("https://2130706433/x")).toMatch(/SSRF|reserved|loopback/i);
    expect(reason("https://0x7f000001/x")).toMatch(/SSRF|reserved|loopback/i);
  });

  it("blocks reserved IPv6 literals incl. IPv4-mapped", () => {
    for (const u of ["https://[::1]/x", "https://[fc00::1]/x", "https://[fe80::1]/x", "https://[::ffff:127.0.0.1]/x"]) {
      expect(reason(u)).toMatch(/SSRF|reserved|loopback/i);
    }
  });

  it("allows http + loopback ONLY when the caller opts in (the callback server / a local backend)", () => {
    expect(reason("http://127.0.0.1:8765/callback", false)).not.toBeNull();
    expect(reason("http://127.0.0.1:8765/callback", true)).toBeNull();
    expect(reason("http://localhost:8765/callback", true)).toBeNull();
    expect(reason("http://[::1]:8765/callback", true)).toBeNull();
    // ...but a non-loopback private IP stays blocked even with allowLoopback.
    expect(reason("http://10.0.0.1/x", true)).not.toBeNull();
  });

  it("assertSafeAuthUrl throws UnsafeAuthUrlError with the reason", () => {
    expect(() => assertSafeAuthUrl("https://169.254.169.254/")).toThrow(UnsafeAuthUrlError);
  });
});

describe("host classifiers", () => {
  it("isLoopbackHost", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.5.5.5")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });

  it("isReservedIpLiteral treats hostnames as non-reserved (DNS is the caller's job)", () => {
    expect(isReservedIpLiteral("evil.example.com")).toBe(false); // can't know without DNS
    expect(isReservedIpLiteral("8.8.8.8")).toBe(false);
    expect(isReservedIpLiteral("192.168.0.1")).toBe(true);
    expect(isReservedIpLiteral("fe80::1")).toBe(true);
  });
});
