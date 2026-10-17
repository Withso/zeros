import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The S3 device stream (`POST /v1/device-sessions`, `/v1/device-stream`) is
// cloud-only. Until the cloud SDK opens it for cloud workspaces, no desktop
// code path may dial it, so a Local workspace (Personal or organization
// Local) can never open one; renderer polling stays the only catalog source.
const DESKTOP = join(process.cwd(), "apps", "desktop");
const ROOTS = ["src", "electron"].map(root => join(DESKTOP, root));
const DEVICE_STREAM_REFERENCE = /\/v1\/device-(?:stream|sessions)\b/;

function sources(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "__tests__") continue;
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry) && !/\.test\.[a-z]+$/.test(entry)) found.push(path);
  }
  return found;
}

describe("device stream Local boundary", () => {
  it("never opens the device stream from desktop code", () => {
    const files = ROOTS.flatMap(root => { try { return sources(root); } catch { return []; } });
    expect(files.length).toBeGreaterThan(100);
    const offenders = files.filter(file => DEVICE_STREAM_REFERENCE.test(readFileSync(file, "utf8")))
      .map(file => relative(DESKTOP, file));
    expect(offenders).toEqual([]);
  });
});
