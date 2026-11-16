// Release candidates: a staff-only opt-in that lets the Production app follow the
// rolling `rc` prerelease, where every Production release is published before it
// is promoted to Latest (docs/release-candidates-roadmap.md). The choice is kept in
// main so it applies at launch, before any renderer or sign-in exists.
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

const FILE = "release-candidates.json";
const RELEASES = "https://github.com/Withso/zeros/releases";

/** The rolling candidate feed, shaped like the generic feeds in updater.ts. */
export const RELEASE_CANDIDATE_FEED = {
  metadataUrl: `${RELEASES}/download/rc/rc-mac.yml`,
  url: `${RELEASES}/download/rc?static=1`,
  channel: "rc",
} as const;

function file(): string {
  return path.join(app.getPath("userData"), FILE);
}

/** Sync: setupUpdater reads it before the launch check. Missing or corrupt → off. */
export function readReleaseCandidatesEnabled(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(file(), "utf8")) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/** Best-effort, like appearance.json: the in-memory choice applies even if the write fails. */
export function writeReleaseCandidatesEnabled(enabled: boolean): void {
  try {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, enabled }), { encoding: "utf8", mode: 0o600 });
  } catch {
    /* next launch falls back to off */
  }
}
