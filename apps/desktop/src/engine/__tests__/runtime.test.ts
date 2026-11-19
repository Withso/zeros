import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isDevRuntime,
  engineBasePort,
  channel,
  isChannel,
  schemeForChannel,
  CHANNELS,
  ENGINE_BASE_PORT_ALPHA,
  ENGINE_BASE_PORT_BETA,
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

  it("ZEROS_CHANNEL=beta → Beta's own base port 24203", () => {
    process.env.ZEROS_CHANNEL = "beta";
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_BETA);
    expect(ENGINE_BASE_PORT_BETA).toBe(24203);
  });

  it("Stable, Beta, and Dev full footprints never overlap", () => {
    // Testing only the listener span would miss collisions on the gateway and OAuth callback ports.
    const footprintHigh = (base: number) => base + ENGINE_PORT_SPAN + 1;
    expect(footprintHigh(ENGINE_BASE_PORT_PROD)).toBeLessThan(
      ENGINE_BASE_PORT_BETA,
    );
    expect(footprintHigh(ENGINE_BASE_PORT_BETA)).toBeLessThan(
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
    process.env.ZEROS_CHANNEL = "beta";
    expect(channel()).toBe("beta");
    process.env.ZEROS_CHANNEL = "stable";
    expect(channel()).toBe("stable");
  });

  it("channel() falls back to dev on the dev signal when unset", () => {
    process.env.ZEROS_DEV = "1";
    expect(channel()).toBe("dev");
  });

  it("an unknown ZEROS_CHANNEL THROWS rather than silently becoming stable", () => {
    process.env.ZEROS_CHANNEL = "garbage";
    expect(() => channel()).toThrow(/not a known channel/);
    process.env.ZEROS_DEV = "1";
    expect(() => channel()).toThrow(/not a known channel/);
  });

  it("the throw names the offending value AND the valid set (actionable message)", () => {
    process.env.ZEROS_CHANNEL = "Beta"; // wrong case — a realistic typo
    expect(() => channel()).toThrow(/Beta/);
    expect(() => channel()).toThrow(CHANNELS.join(" | "));
  });

  it("an ABSENT or EMPTY channel still falls back — Production never sets it", () => {
    delete process.env.ZEROS_CHANNEL;
    expect(channel()).toBe("stable");
    process.env.ZEROS_CHANNEL = "";
    expect(channel()).toBe("stable");
    process.env.ZEROS_DEV = "1";
    expect(channel()).toBe("dev");
  });

  it("isChannel narrows exactly the known set", () => {
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true);
    for (const bad of ["", "Beta", "STABLE", "prod", undefined, null, 1]) {
      expect(isChannel(bad)).toBe(false);
    }
  });

  it("schemeForChannel maps each channel to a DISTINCT scheme", () => {
    expect(schemeForChannel("stable")).toBe("zeros");
    expect(schemeForChannel("alpha")).toBe("zeros-alpha");
    expect(schemeForChannel("beta")).toBe("zeros-beta");
    expect(schemeForChannel("dev")).toBe("zeros-dev");
    const schemes = CHANNELS.map(schemeForChannel);
    expect(new Set(schemes).size).toBe(CHANNELS.length);
    for (const ch of CHANNELS) {
      if (ch === "stable") continue;
      expect(schemeForChannel(ch)).not.toBe(schemeForChannel("stable"));
    }
  });
});

describe("alpha channel isolation", () => {
  it("ZEROS_CHANNEL=alpha → its own base port 24213", () => {
    process.env.ZEROS_CHANNEL = "alpha";
    expect(channel()).toBe("alpha");
    expect(engineBasePort()).toBe(ENGINE_BASE_PORT_ALPHA);
    expect(ENGINE_BASE_PORT_ALPHA).toBe(24213);
  });

  it("all FOUR channels own disjoint port footprints", () => {
    // Include both gateway ports so this also covers collisions outside the listener walk.
    const FOOTPRINT = ENGINE_PORT_SPAN + 2;
    const bases = [
      ENGINE_BASE_PORT_PROD,
      ENGINE_BASE_PORT_BETA,
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

  it("alpha sits after beta's full footprint and before dev", () => {
    expect(ENGINE_BASE_PORT_ALPHA).toBeGreaterThanOrEqual(
      ENGINE_BASE_PORT_BETA + ENGINE_PORT_SPAN + 2,
    );
    expect(ENGINE_BASE_PORT_ALPHA).toBeLessThan(ENGINE_BASE_PORT_DEV);
  });

  it("alpha resolves its own dot-dir, data dir and workspaces root", () => {
    process.env.ZEROS_CHANNEL = "alpha";
    expect(schemeForChannel("alpha")).toBe("zeros-alpha");
    // The data paths are covered in channel-dot-dir.test.ts.
    expect(channel()).toBe("alpha");
  });
});
