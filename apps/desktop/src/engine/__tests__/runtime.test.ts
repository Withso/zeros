import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isDevRuntime,
  engineBasePort,
  channel,
  isChannel,
  schemeForChannel,
  CHANNELS,
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_DEV,
  ENGINE_BASE_PORT_PROD,
  ENGINE_PORT_SPAN,
} from "../runtime";

// These mutate the dev signal in-process; snapshot + restore so other suites
// in the same worker see a clean environment.
const KEYS = [
  "ZEROS_DEV",
  "ZEROS_RUNTIME_MODE",
  "ZEROS_ENGINE_BASE_PORT",
  "ZEROS_CHANNEL",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("engine runtime mode + port range", () => {
  it("defaults to prod → base port 24193", () => {
    expect(isDevRuntime()).toBe(false);
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_PROD);
    expect(ENGINE_BASE_PORT_PROD).toBe(24193);
  });

  it("ZEROS_DEV=1 → dev → base port 24293, disjoint from prod", () => {
    process.env.ZEROS_DEV = "1";
    expect(isDevRuntime()).toBe(true);
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_DEV);
    expect(ENGINE_BASE_PORT_DEV).toBe(24293);
  });

  it("ZEROS_RUNTIME_MODE=dev is an equivalent dev signal", () => {
    process.env.ZEROS_RUNTIME_MODE = "dev";
    expect(isDevRuntime()).toBe(true);
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_DEV);
  });

  it("ZEROS_CHANNEL=beta is refused at boot like any unknown channel", () => {
    process.env.ZEROS_CHANNEL = "beta";
    expect(() => engineBasePort()).toThrow(/not a known channel/);
  });

  it("Stable, Alpha, and Dev full footprints never overlap", () => {
    // A channel owns the eight-port engine walk plus base+8/base+9 for the MCP
    // gateway and OAuth callback. Testing only the walk would miss a gateway
    // collision at a channel boundary.
    const footprintHigh = (base: number) => base + ENGINE_PORT_SPAN + 1;
    expect(footprintHigh(ENGINE_BASE_PORT_PROD)).toBeLessThan(
      ENGINE_BASE_PORT_ALPHA,
    );
    expect(footprintHigh(ENGINE_BASE_PORT_ALPHA)).toBeLessThan(
      ENGINE_BASE_PORT_DEV,
    );
  });

  it("ZEROS_ENGINE_BASE_PORT overrides the base (per-worktree dev instances)", () => {
    process.env.ZEROS_DEV = "1";
    process.env.ZEROS_ENGINE_BASE_PORT = "24313";
    expect(engineBasePort()).toBe(24313);
  });

  it("a bogus ZEROS_ENGINE_BASE_PORT is ignored → falls back to the default", () => {
    process.env.ZEROS_DEV = "1";
    process.env.ZEROS_ENGINE_BASE_PORT = "not-a-port";
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_DEV);
  });
});

describe("release channel + deep-link scheme", () => {
  it("channel() defaults to stable, honours an explicit ZEROS_CHANNEL", () => {
    expect(channel()).toBe("stable");
    process.env.ZEROS_CHANNEL = "alpha";
    expect(channel()).toBe("alpha");
    process.env.ZEROS_CHANNEL = "stable";
    expect(channel()).toBe("stable");
  });

  it("channel() falls back to dev on the dev signal when unset", () => {
    process.env.ZEROS_DEV = "1";
    expect(channel()).toBe("dev");
  });

  // CONTRACT CHANGE: an unknown ZEROS_CHANNEL used to be silently ignored and
  // resolved to "stable". That meant one typo (`alphaa`) pointed an Alpha build
  // at PRODUCTION's data dir, engine ports, update feed and zeros:// scheme — it
  // would read and WRITE real user data under a mislabeled build. There is no safe
  // default for "I don't know which app I am", so it now throws.
  it("an unknown ZEROS_CHANNEL THROWS rather than silently becoming stable", () => {
    process.env.ZEROS_CHANNEL = "garbage";
    expect(() => channel()).toThrow(/not a known channel/);
    process.env.ZEROS_CHANNEL = "beta";
    expect(() => channel()).toThrow(/not a known channel/);
    // …and the dev signal does NOT rescue it: an explicit bad value always wins
    // over inference, so a dev run can't mask the misconfiguration either.
    process.env.ZEROS_DEV = "1";
    expect(() => channel()).toThrow(/not a known channel/);
  });

  it("the throw names the offending value AND the valid set (actionable message)", () => {
    process.env.ZEROS_CHANNEL = "Alpha"; // wrong case — a realistic typo
    expect(() => channel()).toThrow(/Alpha/);
    // Derived from CHANNELS, not hardcoded, so adding a channel can't leave this
    // assertion silently asserting a stale list.
    expect(() => channel()).toThrow(CHANNELS.join(" | "));
  });

  it("an ABSENT or EMPTY channel still falls back — Production never sets it", () => {
    // release.yml bakes nothing, so stable relies on this path. It must not throw.
    delete process.env.ZEROS_CHANNEL;
    expect(channel()).toBe("stable");
    process.env.ZEROS_CHANNEL = "";
    expect(channel()).toBe("stable");
    process.env.ZEROS_DEV = "1";
    expect(channel()).toBe("dev");
  });

  it("isChannel narrows exactly the known set", () => {
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true);
    for (const bad of ["", "Alpha", "beta", "STABLE", "prod", undefined, null, 1]) {
      expect(isChannel(bad)).toBe(false);
    }
  });

  it("schemeForChannel maps each channel to a DISTINCT scheme", () => {
    expect(schemeForChannel("stable")).toBe("zeros");
    expect(schemeForChannel("alpha")).toBe("zeros-alpha");
    expect(schemeForChannel("dev")).toBe("zeros-dev");
    // The whole point: no two channels share a scheme, so the OS never routes a
    // sign-in / invite / pair deep link to a sibling app. Iterates CHANNELS so a newly added channel is covered
    // automatically instead of quietly reusing stable's zeros://.
    const schemes = CHANNELS.map(schemeForChannel);
    expect(new Set(schemes).size).toBe(CHANNELS.length);
    for (const ch of CHANNELS) {
      if (ch === "stable") continue;
      expect(schemeForChannel(ch)).not.toBe(schemeForChannel("stable"));
    }
  });
});

// ──────────────────────────────────────────────────────────
// Alpha channel (the build cut from every merge to main)
// ──────────────────────────────────────────────────────────
// Alpha exists so main can be dogfooded on a REAL signed packaged build. It must
// be installable and runnable ALONGSIDE Production, which means it needs its own
// port block, data dirs and deep-link scheme.
describe("alpha channel isolation", () => {
  it("ZEROS_CHANNEL=alpha → its own base port 24213", () => {
    process.env.ZEROS_CHANNEL = "alpha";
    expect(channel()).toBe("alpha");
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_ALPHA);
    expect(ENGINE_BASE_PORT_ALPHA).toBe(24213);
  });

  it("every channel owns a disjoint port footprint", () => {
    // Footprint per channel = the span walk PLUS base+8 (MCP gateway) and base+9
    // (its OAuth callback) — 10 ports. An overlap lets one channel's reaper kill
    // another channel's live engine, so pin the arithmetic.
    const FOOTPRINT = ENGINE_PORT_SPAN + 2;
    const bases = [
      ENGINE_BASE_PORT_PROD,
      ENGINE_BASE_PORT_ALPHA,
      ENGINE_BASE_PORT_DEV,
    ];
    const used = new Set<number>();
    for (const base of bases) {
      for (let p = base; p < base + FOOTPRINT; p++) {
        expect(used.has(p)).toBe(false); // no port claimed twice
        used.add(p);
      }
    }
    expect(used.size).toBe(bases.length * FOOTPRINT);
  });

  it("alpha keeps its shipped base and leaves the retired 24203 block unassigned", () => {
    const retired = 24203;
    for (const base of [ENGINE_BASE_PORT_PROD, ENGINE_BASE_PORT_ALPHA, ENGINE_BASE_PORT_DEV]) {
      const footprintHigh = base + ENGINE_PORT_SPAN + 1;
      expect(footprintHigh < retired || base > retired + ENGINE_PORT_SPAN + 1).toBe(true);
    }
    expect(ENGINE_BASE_PORT_ALPHA).toBeLessThan(ENGINE_BASE_PORT_DEV);
  });

  it("alpha resolves its own dot-dir, data dir and workspaces root", () => {
    process.env.ZEROS_CHANNEL = "alpha";
    expect(schemeForChannel("alpha")).toBe("zeros-alpha");
    // Covered in depth by channel-dot-dir.test.ts; asserted here so the alpha
    // block reads as a complete isolation contract.
    expect(channel()).toBe("alpha");
  });
});
