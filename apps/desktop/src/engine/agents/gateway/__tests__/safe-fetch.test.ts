import { describe, expect, it } from "vitest";
import { safeAuthFetch, type FetchFn, type LookupAllFn } from "../safe-fetch";

// Public address every "good" host resolves to (not in any reserved range).
const PUBLIC = "93.184.216.34";

function makeLookup(map: Record<string, string[]> = {}): LookupAllFn {
  return async (host: string) => map[host] ?? [PUBLIC];
}

function ok(body = "{}"): Response {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}
function redirect(to: string, status = 302): Response {
  return new Response(null, { status, headers: { location: to } });
}

describe("safeAuthFetch (gateway SSRF guard)", () => {
  it("allows a public HTTPS GET and returns the response", async () => {
    const fetchImpl: FetchFn = async () => ok('{"ok":true}');
    const res = await safeAuthFetch("https://mcp.example.com/.well-known", undefined, {
      fetchImpl,
      lookupImpl: makeLookup(),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it("rejects an initial URL whose host is a private IP literal", async () => {
    const fetchImpl: FetchFn = async () => ok();
    await expect(
      safeAuthFetch("https://169.254.169.254/latest/meta-data/", undefined, {
        fetchImpl,
        lookupImpl: makeLookup(),
      }),
    ).rejects.toThrow(/SSRF|private\/reserved/i);
  });

  it("rejects a public host that DNS-resolves to a private address (rebinding)", async () => {
    const fetchImpl: FetchFn = async () => ok();
    await expect(
      safeAuthFetch("https://evil.example.com/mcp", undefined, {
        fetchImpl,
        lookupImpl: makeLookup({ "evil.example.com": ["10.0.0.5"] }),
      }),
    ).rejects.toThrow(/resolves to a private\/reserved address/i);
  });

  it("rejects a public host that resolves to cloud metadata (169.254.x)", async () => {
    const fetchImpl: FetchFn = async () => ok();
    await expect(
      safeAuthFetch("https://innocent.example.com/mcp", undefined, {
        fetchImpl,
        lookupImpl: makeLookup({ "innocent.example.com": ["169.254.169.254"] }),
      }),
    ).rejects.toThrow(/resolves to a private\/reserved address/i);
  });

  it("does NOT follow a redirect to a loopback/internal target — re-validates the hop", async () => {
    let calls = 0;
    const fetchImpl: FetchFn = async () => {
      calls++;
      return redirect("http://127.0.0.1:9999/admin"); // first (only) call 302s to loopback
    };
    await expect(
      safeAuthFetch("https://mcp.example.com/discovery", undefined, {
        fetchImpl,
        lookupImpl: makeLookup(),
      }),
    ).rejects.toThrow(/unsafe URL|SSRF|http/i);
    expect(calls).toBe(1); // we issued the first request, then refused the redirect target
  });

  it("does NOT follow a redirect to a public host that resolves private", async () => {
    const fetchImpl: FetchFn = async (url) =>
      String(url).includes("step2") ? ok() : redirect("https://step2.example.com/x");
    await expect(
      safeAuthFetch("https://mcp.example.com/discovery", undefined, {
        fetchImpl,
        lookupImpl: makeLookup({ "step2.example.com": ["192.168.1.10"] }),
      }),
    ).rejects.toThrow(/resolves to a private\/reserved address/i);
  });

  it("follows a SAFE redirect between public hosts and returns the final response", async () => {
    const fetchImpl: FetchFn = async (url) =>
      String(url).includes("canonical") ? ok('{"final":1}') : redirect("https://canonical.example.com/mcp", 308);
    const res = await safeAuthFetch("https://mcp.example.com/old", undefined, {
      fetchImpl,
      lookupImpl: makeLookup(),
    });
    expect(await res.text()).toBe('{"final":1}');
  });

  it("refuses to follow a redirect on a non-GET (token POST) request", async () => {
    const fetchImpl: FetchFn = async () => redirect("https://other.example.com/token");
    await expect(
      safeAuthFetch("https://mcp.example.com/token", { method: "POST", body: "grant_type=x" }, {
        fetchImpl,
        lookupImpl: makeLookup(),
      }),
    ).rejects.toThrow(/refused to follow|redirect/i);
  });

  it("caps the redirect chain", async () => {
    let n = 0;
    const fetchImpl: FetchFn = async () => redirect(`https://hop${n++}.example.com/x`);
    await expect(
      safeAuthFetch("https://start.example.com/x", undefined, {
        fetchImpl,
        lookupImpl: makeLookup(),
        maxRedirects: 3,
      }),
    ).rejects.toThrow(/redirects/i);
  });

  it("strips Authorization across a redirect hop (never replays a credential)", async () => {
    const seen: (string | null)[] = [];
    const fetchImpl: FetchFn = async (url, init) => {
      seen.push(new Headers(init?.headers).get("authorization"));
      return String(url).includes("step2") ? ok() : redirect("https://step2.example.com/x");
    };
    await safeAuthFetch(
      "https://mcp.example.com/discovery",
      { headers: { Authorization: "Bearer secret-token" } },
      { fetchImpl, lookupImpl: makeLookup() },
    );
    expect(seen[0]).toBe("Bearer secret-token"); // first hop keeps it
    expect(seen[1]).toBeNull(); // redirect hop drops it
  });

  it("allows a loopback backend only when allowLoopback is set", async () => {
    const fetchImpl: FetchFn = async () => ok();
    // blocked by default
    await expect(
      safeAuthFetch("http://127.0.0.1:8080/mcp", undefined, { fetchImpl, lookupImpl: makeLookup() }),
    ).rejects.toThrow();
    // permitted with the opt-in (local-dev backend / the gateway's own loopback)
    const res = await safeAuthFetch("http://127.0.0.1:8080/mcp", undefined, {
      fetchImpl,
      lookupImpl: makeLookup(),
      allowLoopback: true,
    });
    expect(res.status).toBe(200);
  });
});
