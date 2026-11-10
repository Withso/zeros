import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { hostname } from "node:os";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** One stable id per signed-in account on this install. */
export function deviceIdFor(store: { get(key: string): string; set(key: string, value: string): void }, accountId: string): string {
  const key = `localCommandsDevice.${createHash("sha256").update(accountId).digest("hex").slice(0, 32)}`;
  const existing = store.get(key);
  if (UUID.test(existing)) return existing.toLowerCase();
  const created = randomUUID();
  store.set(key, created);
  return created;
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
