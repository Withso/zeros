import { lookup } from "node:dns";
import { get } from "node:https";
import type { LookupFunction } from "node:net";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";
import { isReservedIpLiteral } from "../src/engine/agents/gateway/oauth-url";

/** Artwork uses a fresh, anonymous HTTPS socket, never an authenticated
 * browser partition. Resolve and pin public DNS addresses on every redirect;
 * no cookie jar, proxy credentials, referrer, or arbitrary request options. */
export const publicArtworkLookup: LookupFunction = (
  hostname,
  options,
  callback,
) => {
  lookup(hostname, { all: true }, (error, addresses) => {
    if (
      error ||
      !addresses.length ||
      addresses.some(
        ({ address }) =>
          isReservedIpLiteral(address) ||
          (address.includes(":") && !/^[23][\da-f]{3}:/i.test(address)),
      )
    ) {
      callback(new Error("Artwork address unavailable"), "", 0);
      return;
    }
    if (options.all) callback(null, addresses);
    else {
      const first =
        addresses.find(
          (entry) => !options.family || entry.family === options.family,
        ) ?? addresses[0]!;
      callback(null, first.address, first.family);
    }
  });
};

const MAX_BYTES = 64 * 1024;
interface ArtworkResponse {
  status: number;
  location?: string;
  mime?: string;
  bytes: Buffer;
}
export type ArtworkRequest = (
  url: string,
  signal: AbortSignal,
) => Promise<ArtworkResponse>;
const requestArtwork: ArtworkRequest = (url, signal) =>
  new Promise((resolve, reject) => {
    const request = get(
      url,
      {
        agent: false,
        lookup: publicArtworkLookup,
        signal,
        headers: { accept: "image/*", "accept-encoding": "identity" },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const result = {
          status,
          location: response.headers.location,
          mime: response.headers["content-type"],
        };
        if (status !== 200) {
          response.destroy();
          resolve({ ...result, bytes: Buffer.alloc(0) });
          return;
        }
        if (Number(response.headers["content-length"]) > MAX_BYTES) {
          response.destroy();
          reject(new Error("Artwork exceeds limit"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES)
            response.destroy(new Error("Artwork exceeds limit"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({ ...result, bytes: Buffer.concat(chunks) }),
        );
      },
    );
    request.on("error", reject);
  });

/** Passive bytes only; renderer gets bounded data URLs and never fetches
 * provider artwork using its own cookies. Missing artwork stays quiet. */
export async function fetchToolArtwork(
  raw: unknown,
  read: ArtworkRequest = requestArtwork,
): Promise<string | null> {
  let url = safeToolImageSource(raw);
  if (!url?.startsWith("https:")) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  timer.unref?.();
  try {
    const seen = new Set<string>();
    for (let hop = 0; hop < 4; hop++) {
      if (seen.has(url)) return null;
      seen.add(url);
      const result = await read(url, controller.signal);
      if (
        [301, 302, 303, 307, 308].includes(result.status) &&
        result.location
      ) {
        const next = safeToolImageSource(new URL(result.location, url).href);
        if (!next?.startsWith("https:")) return null;
        url = next;
        continue;
      }
      if (
        result.status !== 200 ||
        !result.bytes.length ||
        result.bytes.length > MAX_BYTES
      )
        return null;
      const mime = result.mime
        ?.split(";")[0]
        ?.trim()
        .toLowerCase()
        .replace("image/vnd.microsoft.icon", "image/x-icon");
      return (
        safeToolImageSource(
          `data:${mime};base64,${result.bytes.toString("base64")}`,
        ) ?? null
      );
    }
  } catch {
    /* artwork must never fail the tool or create transcript noise */
  } finally {
    clearTimeout(timer);
  }
  return null;
}
