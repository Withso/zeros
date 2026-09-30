import { describe, expect, it } from "vitest";
import { buildReleaseLedger, previousReleaseLedger, releaseLedgerAsset, releaseLedgerUrl, verifyPublishedReleaseLedger } from "./release-ledger";

const repository = "example/zeros", sourceSha = "a".repeat(40);
const entry = (number: number) => ({ version: `0.1.20-alpha.${number}`, publishedAt: new Date(Date.UTC(2026, 8, 1, 0, number)).toISOString(), sourceSha });

describe("cumulative desktop release ledger", () => {
  it.each(["alpha", "beta", "production"] as const)("builds the %s contract and channel asset", channel => {
    const release = { ...entry(1), version: channel === "production" ? "0.1.20" : `0.1.20-${channel}.1` };
    expect(buildReleaseLedger(channel, null, release)).toEqual({ version: 1, channel, releases: [release] });
    expect(releaseLedgerUrl(repository, channel)).toBe(`https://github.com/${repository}/releases/${channel === "production" ? "latest/download" : `download/${channel}`}/${releaseLedgerAsset(channel)}`);
  });
  it("appends without mutating its input and bounds history to the newest 200", () => {
    const previous = { version: 1, channel: "alpha", releases: Array.from({ length: 200 }, (_, index) => entry(index + 1)) };
    const snapshot = structuredClone(previous), ledger = buildReleaseLedger("alpha", previous, entry(201));
    expect(previous).toEqual(snapshot); expect(ledger.releases).toHaveLength(200);
    expect(ledger.releases[0]).toEqual(entry(2)); expect(ledger.releases.at(-1)).toEqual(entry(201));
  });
  it("uses stable chronological ordering, including simultaneous publications", () => {
    const first = entry(1), second = { ...entry(2), publishedAt: first.publishedAt };
    const previous = { version: 1, channel: "alpha", releases: [first, second] };
    expect(buildReleaseLedger("alpha", previous, entry(3)).releases).toEqual([first, second, entry(3)]);
  });
  it("a retry preserves the original publication time and cannot extend the support window", () => {
    const previous = buildReleaseLedger("alpha", null, entry(1));
    expect(buildReleaseLedger("alpha", previous, { ...entry(1), publishedAt: entry(2).publishedAt })).toEqual(previous);
    expect(() => buildReleaseLedger("alpha", previous, { ...entry(1), sourceSha: "b".repeat(40) })).toThrow(/overwritten/);
  });
  it("fails closed on corrupt history, wrong channels, duplicate versions and backward publication", () => {
    const previous = buildReleaseLedger("alpha", null, entry(2));
    for (const invalid of [{ ...previous, channel: "beta" }, { ...previous, version: 2 }, { ...previous, releases: [{ ...entry(2), sourceSha: "short" }] },
      { ...previous, releases: [entry(2), entry(2)] }]) expect(() => buildReleaseLedger("alpha", invalid, entry(3))).toThrow();
    expect(() => buildReleaseLedger("alpha", previous, { ...entry(3), publishedAt: entry(1).publishedAt })).toThrow(/backwards/);
    expect(() => buildReleaseLedger("alpha", previous, entry(1))).toThrow(/monotonically/);
    expect(() => buildReleaseLedger("beta", null, entry(1))).toThrow(/channel/);
  });
  it("reads the prior ledger from the channel feed release without sending authorization to its asset", async () => {
    const previous = buildReleaseLedger("alpha", null, entry(1)), requests: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      return String(url).startsWith("https://api.github.com/") ? Response.json({ tag_name: "alpha", draft: false, prerelease: true,
        assets: [{ name: "alpha-release-ledger.json", browser_download_url: releaseLedgerUrl(repository, "alpha") }] }) : Response.json(previous);
    };
    expect(await previousReleaseLedger(repository, "alpha", "fake-token", fetcher)).toEqual(previous);
    expect(requests[0].headers.get("authorization")).toBe("Bearer fake-token");
    expect(requests[1].headers.has("authorization")).toBe(false);
  });
  it("bootstraps an absent legacy asset, but never resets inaccessible or invalid history", async () => {
    expect(await previousReleaseLedger(repository, "alpha", undefined, async () => new Response(null, { status: 404 }))).toBeNull();
    expect(await previousReleaseLedger(repository, "alpha", undefined, async () => Response.json({ tag_name: "alpha", draft: false, prerelease: true, assets: [] }))).toBeNull();
    await expect(previousReleaseLedger(repository, "alpha", undefined, async () => new Response(null, { status: 403 }))).rejects.toThrow(/discard/);
    await expect(previousReleaseLedger(repository, "alpha", undefined, async () => Response.json({ tag_name: "alpha", draft: false, prerelease: true,
      assets: [{ name: "alpha-release-ledger.json", browser_download_url: "https://other.example/ledger" }] }))).rejects.toThrow(/feed asset/);
  });
  it("reads back the exact cumulative ledger anonymously and tolerates CDN propagation", async () => {
    const expected = buildReleaseLedger("alpha", null, entry(2));
    let reads = 0;
    await verifyPublishedReleaseLedger(repository, expected, { attempts: 3, sleep: async () => {}, fetch: async (url, init) => {
      expect(String(url).startsWith(`${releaseLedgerUrl(repository, "alpha")}?`)).toBe(true);
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      reads++; return Response.json(reads === 1 ? buildReleaseLedger("alpha", null, entry(1)) : expected);
    } });
    expect(reads).toBe(2);
    await expect(verifyPublishedReleaseLedger(repository, expected, { attempts: 1, sleep: async () => {}, fetch: async () => new Response(null, { status: 404 }) })).rejects.toThrow(/timed out/);
  });
});
