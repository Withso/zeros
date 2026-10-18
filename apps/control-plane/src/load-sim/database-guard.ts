import { promises as dns } from "node:dns";
import { isIP } from "node:net";

/** The simulator rebuilds its database with DROP SCHEMA, so only names in this allow-list are disposable. */
export const LOAD_SIM_DATABASE_NAME = /^zeros_load_sim[A-Za-z0-9_-]*$/;

export type LookupAll = (hostname: string) => Promise<readonly { address: string }[]>;

const lookupAll: LookupAll = hostname => dns.lookup(hostname, { all: true });

/** An IP literal in 127.0.0.0/8, or ::1. A DNS name such as `127.example.com` is not loopback. */
export function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith("127.");
  return family === 6 && address === "::1";
}

export async function assertDisposableLoopbackDatabase(url: string, lookup: LookupAll = lookupAll): Promise<void> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("LOAD_SIM_DATABASE_URL is not a valid URL"); }
  // pg-connection-string copies query parameters into the config first and
  // only falls back to the URL host when `host` is unset, so
  // `?host=prod.example.com` would silently override the validated loopback.
  if ([...parsed.searchParams.keys()].length > 0)
    throw new Error("LOAD_SIM_DATABASE_URL must not carry query parameters: pg applies them over the URL host, bypassing the loopback check");
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") {
    // Guard against a localhost that resolves somewhere unexpected.
    const addresses = await lookup("localhost");
    if (!addresses.length || addresses.some(({ address }) => !isLoopbackAddress(address)))
      throw new Error("The load simulator rebuilds its database and localhost must resolve only to loopback addresses");
  } else if (!isLoopbackAddress(host)) {
    throw new Error("The load simulator rebuilds its database and accepts only a loopback host");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!LOAD_SIM_DATABASE_NAME.test(database))
    throw new Error(`The load simulator drops and rebuilds its database, so the database name must match ${LOAD_SIM_DATABASE_NAME.source} (got "${database}")`);
}
