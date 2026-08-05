// ──────────────────────────────────────────────────────────
// Feature flags — channel-gated (dev | beta | stable)
// ──────────────────────────────────────────────────────────
//
// The RENDERER's view of the release channel plus a tiny flag registry. The
// channel is baked at BUILD time into the bundle (VITE_ZEROS_CHANNEL, injected
// by the release workflows); under `pnpm dev` it is unset and treated as "dev".
//
// Why channel-gated flags at all: Beta and Production build from the SAME `main`
// (Production is a promotion of a proven Beta commit), so you can NOT keep an
// unfinished feature out of Production by "not merging it". Gate it instead —
// ON in dev + beta, OFF in stable — and flip stable on once it's proven.
//
// The MAIN + ENGINE processes have their own resolver (apps/desktop/src/engine/runtime.ts
// `channel()`, keyed off process.env.ZEROS_CHANNEL). Keep the two conceptually
// in sync; this module is purely for gating renderer UI.

/** Keep in lockstep with apps/desktop/src/engine/runtime.ts's CHANNELS. Duplicated (not
 *  imported) because this module is renderer-only and must stay free of any
 *  process.env read; the engine module is the authority for main + engine. */
export const CHANNELS = ["dev", "alpha", "beta", "stable"] as const;

export type Channel = (typeof CHANNELS)[number];

function isChannel(v: unknown): v is Channel {
  return (CHANNELS as readonly unknown[]).includes(v);
}

/** This build's channel. Build-time constant in packaged apps; "dev" under
 *  `pnpm dev` (VITE_ZEROS_CHANNEL unset → import.meta.env.DEV is true). */
export const CHANNEL: Channel = (() => {
  const c = import.meta.env.VITE_ZEROS_CHANNEL;
  if (isChannel(c)) return c;
  return import.meta.env.DEV ? "dev" : "stable";
})();

/** True in the Beta channel. Handy for one-off "show this only in Beta" checks
 *  that don't warrant a named flag. */
export const isBetaChannel: boolean = CHANNEL === "beta";

/** True in the Alpha channel — the build cut from every merge to main. */
export const isAlphaChannel: boolean = CHANNEL === "alpha";

/** True in any PRE-RELEASE channel (dev, alpha, beta) — i.e. not Production.
 *  Prefer this over `!== "stable"` so adding a future channel can't accidentally
 *  opt Production into something. */
export const isPreReleaseChannel: boolean = CHANNEL !== "stable";

/**
 * Feature → the set of channels where it is ON.
 *
 * Promotion ladder, now that Alpha exists:
 *   `["dev", "alpha"]`            lands in main, dogfooded in Alpha
 *   `["dev", "alpha", "beta"]`    promoted into the stabilization cut
 *   `+ "stable"`                  shipped to everyone
 * Delete the entry once the feature is permanent and unconditional.
 *
 * A feature NOT listed here is OFF in every channel — a fail-safe so a typo or a
 * forgotten registration can never silently ship to Production.
 */
const FEATURE_CHANNELS: Record<string, readonly Channel[]> = {
  // Example (delete when the first real flag lands):
  // "new-onboarding": ["dev", "alpha"],
};

/** Whether `feature` is enabled in this build's channel. Unregistered → false. */
export function isFeatureEnabled(feature: string): boolean {
  const channels = FEATURE_CHANNELS[feature];
  return channels ? channels.includes(CHANNEL) : false;
}
