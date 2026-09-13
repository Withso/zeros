import { describe, expect, it, vi } from "vitest";
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: dns.lookup }));
import { fetchToolArtwork, publicArtworkLookup } from "../tool-artwork";

describe("anonymous tool artwork", () => {
  it("pins public DNS results and refuses mixed private or multicast destinations", () => {
    const result = vi.fn();
    dns.lookup.mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: "8.8.8.8", family: 4 }]),
    );
    publicArtworkLookup("example.com", {}, result);
    expect(result).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
    for (const address of [
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fc00::1",
      "ff02::1",
    ]) {
      result.mockClear();
      dns.lookup.mockImplementation((_host, _options, callback) =>
        callback(null, [
          { address: "8.8.8.8", family: 4 },
          { address, family: address.includes(":") ? 6 : 4 },
        ]),
      );
      publicArtworkLookup("example.com", { all: true }, result);
      expect(result.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    }
  });
  it("fetches passive artwork without relying on browser CORS or credentials", async () => {
    const read = vi.fn(async () => ({
      status: 200,
      mime: "image/png",
      bytes: Buffer.from("fixture"),
    }));
    expect(
      await fetchToolArtwork("https://example.com/favicon.ico", read),
    ).toBe("data:image/png;base64,Zml4dHVyZQ==");
    expect(read.mock.calls[0]).toHaveLength(2);
  });
  it("revalidates redirects and refuses active content and oversized responses", async () => {
    for (const location of [
      "http://example.com/icon",
      "https://127.0.0.1/icon",
      "file:///tmp/icon",
      "https://user:password@example.com/icon",
    ]) {
      const read = vi.fn(async () => ({
        status: 302,
        location,
        bytes: Buffer.alloc(0),
      }));
      expect(
        await fetchToolArtwork("https://example.com/icon", read),
      ).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
    }
    expect(
      await fetchToolArtwork("https://example.com/icon", async () => ({
        status: 200,
        mime: "text/html",
        bytes: Buffer.from("<html/>"),
      })),
    ).toBeNull();
    expect(
      await fetchToolArtwork("https://example.com/icon", async () => ({
        status: 200,
        mime: "image/png",
        bytes: Buffer.alloc(65 * 1024),
      })),
    ).toBeNull();
  });
  it("bounds redirect loops and suppresses offline failures", async () => {
    const read = vi.fn(async () => ({
      status: 302,
      location: "/icon",
      bytes: Buffer.alloc(0),
    }));
    expect(await fetchToolArtwork("https://example.com/icon", read)).toBeNull();
    expect(read).toHaveBeenCalledTimes(1);
    expect(
      await fetchToolArtwork("https://example.com/icon", async () => {
        throw new Error("offline");
      }),
    ).toBeNull();
  });
});
