// Pins the per-channel auto-update policy.
//
// EVERY packaged channel auto-updates from GitHub Releases: stable follows
// /releases/latest/download (whatever is marked Latest), alpha and beta read their
// own rolling release tag. Each channel MUST point at its own base, or a pre-release
// install would update itself into Production.
//
// The invariant is BOTH-HALVES-OR-NEITHER:
//
//   UPDATER_FEED_BY_CHANNEL[ch] !== null   ⟺   release-<ch>.yml publishes that feed
//
// #198 broke exactly this: beta's uploads were removed while the app kept polling
// beta's feed, producing a stale feed and a false "You're up to date!". The reverse
// (uploads with no entry) leaves assets nobody reads. An app polling an unpopulated
// base would 404 on a 5-minute interval PLUS every window focus and power resume —
// the "[updater] Error … every ~16 min for 24 h" pattern from the field logs.
//
// This asserts the source side; `check:packaging-paths` asserts the workflow side and
// fails on a half-change in either direction. Parsed from source rather than imported
// because electron/updater.ts pulls in `electron`, which cannot load under vitest.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { CHANNELS } from "../../src/engine/runtime";

const SRC = readFileSync("electron/updater.ts", "utf8");
const feedBlock = SRC.slice(
  SRC.indexOf("const UPDATER_FEED_BY_CHANNEL"),
  SRC.indexOf("};", SRC.indexOf("const UPDATER_FEED_BY_CHANNEL")),
);

/** The `<channel>:` entry's value, collapsed to "null" or "object". */
function entryKind(ch: string): "null" | "object" {
  const m = new RegExp(`^\\s*${ch}:\\s*(null|\\{)`, "m").exec(feedBlock);
  if (!m) throw new Error(`no UPDATER_FEED_BY_CHANNEL entry for "${ch}"`);
  return m[1] === "null" ? "null" : "object";
}

/** The `RELEASES` base constant, resolved out of source so the assertions below
 *  compare EFFECTIVE urls rather than the `${RELEASES}` template text — an
 *  assertion against the template would keep passing if the constant itself were
 *  repointed at the wrong repo. */
const RELEASES_BASE = /const RELEASES = "([^"]+)"/.exec(SRC)?.[1] ?? "";

/** Substitute `${RELEASES}` so an entry reads as the URL it actually resolves to. */
function resolved(entry: string): string {
  return entry.replaceAll("${RELEASES}", RELEASES_BASE);
}

/** The full source text of one channel's `{ … }` entry.
 *
 *  Brace-COUNTED rather than `\{[^}]*\}`: the URLs are template literals, so
 *  `${RELEASES}` puts a closing brace inside the entry and a negated-class regex
 *  stops there — silently matching a truncated entry, which makes every
 *  `toContain` below vacuously pass on a prefix. */
function entryFor(ch: string): string {
  const start = new RegExp(`^\\s*${ch}:\\s*\\{`, "m").exec(feedBlock);
  if (!start) throw new Error(`no object entry for "${ch}"`);
  const open = feedBlock.indexOf("{", start.index);
  let depth = 0;
  for (let i = open; i < feedBlock.length; i++) {
    if (feedBlock[i] === "{") depth++;
    else if (feedBlock[i] === "}" && --depth === 0) {
      return feedBlock.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces in the "${ch}" entry`);
}

describe("UPDATER_FEED_BY_CHANNEL", () => {
  it("stable has a feed (users must keep auto-updating)", () => {
    expect(entryKind("stable")).toBe("object");
  });

  it.each(["alpha", "beta"])("%s has its OWN feed (auto-update enabled)", (ch) => {
    expect(entryKind(ch)).toBe("object");
  });

  it.each(["alpha", "beta"])(
    "%s points at its own rolling release tag, never Production's",
    (ch) => {
      const entry = resolved(entryFor(ch));
      // The rolling tag, NOT /releases/latest/download — that resolves to whatever
      // GitHub marks Latest, which is always a stable release.
      expect(entry).toContain(`/releases/download/${ch}`);
      expect(entry).not.toContain("/releases/latest/download");
      expect(entry).toContain(`channel: "${ch}"`);
      // A pre-release must never downgrade — see the allowDowngrade note in source.
      expect(entry).toContain("allowDowngrade: false");
    },
  );

  it("stable follows the Latest release, not a hardcoded version", () => {
    const stable = resolved(entryFor("stable"));
    expect(stable).toContain("/releases/latest/download");
    expect(stable).toContain('channel: "latest"');
  });

  it("uses the generic provider's base URLs, with no R2 origin left behind", () => {
    expect(RELEASES_BASE).toBe("https://github.com/Withso/zeros/releases");
    // electron-updater's GitHub PROVIDER is unusable here (its channel filter also
    // accepts stable tags), and the R2 origin it replaced is gone.
    expect(SRC).not.toContain("dl.zeros.build");
    expect(SRC).toContain("https://github.com/Withso/zeros/releases");
    // `?static=1` pins the per-poll noCache query off — dropping it makes every
    // check a CDN cache miss.
    for (const ch of ["alpha", "beta", "stable"]) {
      const entry = entryFor(ch);
      expect(entry, `${ch} feed url must pin ?static=1`).toContain("?static=1");
    }
  });

  it("only stable allows downgrade (the 0.1.x → 0.0.x reset escape hatch)", () => {
    const stable = entryFor("stable");
    expect(stable).toContain("allowDowngrade: true");
  });

  it("dev has no feed (unpackaged — nothing to update)", () => {
    expect(entryKind("dev")).toBe("null");
  });

  it("covers every channel, so a new one can't silently inherit Production's feed", () => {
    // The Record is typed `Record<Channel, …>`, so TS already forces exhaustiveness —
    // this catches the case where someone widens Channel and reaches for a default.
    for (const ch of CHANNELS) expect(() => entryKind(ch)).not.toThrow();
  });
});

describe("every updater entry point is gated", () => {
  // A gate on the scheduler alone is NOT enough: `-c.publish.url` bakes a channel URL
  // into the packaged app-update.yml, so electron-updater will poll that prefix on its
  // own initiative unless setupUpdater declines to wire anything at all.
  it("defines updaterEnabled() from IS_PACKAGED *and* the channel's feed", () => {
    const fn = SRC.slice(
      SRC.indexOf("function updaterEnabled()"),
      SRC.indexOf("}", SRC.indexOf("function updaterEnabled()")),
    );
    expect(fn).toContain("IS_PACKAGED");
    expect(fn).toContain("UPDATER_FEED_BY_CHANNEL[channel()] !== null");
  });

  it("gates all four entry points on updaterEnabled(), not on IS_PACKAGED alone", () => {
    // checkAutomatically (the scheduler), setupUpdater (wiring), updaterCheck (the
    // manual menu item) and updaterInstall.
    const gated = SRC.match(/!updaterEnabled\(\)/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(4);
    // No entry point may still guard on bare IS_PACKAGED — that would let a feedless
    // packaged channel through.
    expect(SRC).not.toMatch(/if \(!IS_PACKAGED\) return/);
  });
});
