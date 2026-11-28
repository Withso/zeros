import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SettingStore = { get(key: string): string; set(key: string, value: string): void };
const accountKey = (prefix: string, accountId: string) => `${prefix}.${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}`;
/** Compatibility contract: the device-wide setting every release before
 * per-account consent wrote. */
const LEGACY_ALWAYS_ALLOW_KEY = "localCommandsAlwaysAllow";

/** One stable id per signed-in account on this install. */
export function deviceIdFor(store: SettingStore, accountId: string): string {
  const key = accountKey("localCommandsDevice", accountId);
  const existing = store.get(key);
  if (UUID.test(existing)) return existing.toLowerCase();
  const created = randomUUID();
  store.set(key, created);
  return created;
}

/** Always allow is one person's consent for their own agents, so another
 * account signed in on this Mac never inherits it. A pre-upgrade device-wide
 * value has no owner, so no account adopts it: it is discarded and each
 * account is asked again once. */
export function alwaysAllowFor(store: SettingStore, accountId: string): boolean {
  const value = store.get(accountKey(LEGACY_ALWAYS_ALLOW_KEY, accountId));
  if (store.get(LEGACY_ALWAYS_ALLOW_KEY)) store.set(LEGACY_ALWAYS_ALLOW_KEY, "");
  return value === "true";
}

export function setAlwaysAllowFor(store: SettingStore, accountId: string, value: boolean): void {
  store.set(accountKey(LEGACY_ALWAYS_ALLOW_KEY, accountId), String(value));
}

/** A name the wire accepts: trimmed, 1..128 characters, no control characters. */
export function cleanDeviceName(value: string): string | undefined {
  // Control characters are exactly what the wire refuses in a device name.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 128).trim();
  return cleaned || undefined;
}

/** The Mac's ComputerName (System Settings > General > Sharing), else its host name. Not editable in the app. */
export async function computerName(options: { platform?: NodeJS.Platform; run?: (file: string, args: string[]) => Promise<string>; host?: () => string } = {}): Promise<string> {
  const run = options.run ?? ((file, args) => new Promise<string>((resolve, reject) =>
    execFile(file, args, { timeout: 2_000, encoding: "utf8" }, (error, stdout) => error ? reject(error) : resolve(stdout))));
  if ((options.platform ?? process.platform) === "darwin") {
    const name = await run("/usr/sbin/scutil", ["--get", "ComputerName"]).then(cleanDeviceName, () => undefined);
    if (name) return name;
  }
  return cleanDeviceName((options.host ?? hostname)().replace(/\.local$/, "")) ?? "Mac";
}
