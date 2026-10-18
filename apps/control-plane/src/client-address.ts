import { isIP } from "node:net";

/** The client address that keys pre-authentication limits. Railway's edge
 * sets `X-Real-IP`, so a present value is authoritative; a direct Cloudflare
 * Tunnel strips it and sets `CF-Connecting-IP`. Without either header the
 * socket `peer` is used when the caller has one. Whatever is picked must
 * parse as an IP, or the request shares one `unknown` bucket: a caller never
 * chooses its own key by sending garbage in the trusted header. */
export function clientAddress(header: (name: string) => string | undefined, peer?: string): string {
  const value = (header("x-real-ip") ?? header("cf-connecting-ip") ?? peer)?.trim() ?? "";
  return isIP(value) ? value : "unknown";
}
