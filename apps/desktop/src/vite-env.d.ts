/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project key for the "Zeros Dev" project (dev runtime). */
  readonly VITE_POSTHOG_KEY_DEV?: string;
  /** PostHog project key for the "Zeros" project (prod runtime). */
  readonly VITE_POSTHOG_KEY_PROD?: string;
  /** PostHog host. Defaults to US Cloud. */
  readonly VITE_POSTHOG_HOST?: string;
  /** Public base URL of the hosted web app (https://app.zeros.build). */
  readonly VITE_APP_BASE_URL?: string;
  /** Public base URL of this channel's Railway control plane. */
  readonly VITE_CONTROL_PLANE_URL?: string;
  /** Release channel baked into the bundle at build:
   *  "dev" | "alpha" | "beta" | "stable". Drives renderer feature-flag gating
   *  (apps/desktop/src/renderer/config/release-channel.ts).
   *
   *  Injected explicitly by release-alpha.yml ("alpha") and release-beta.yml
   *  ("beta") — `check:vite-env` asserts both. **release.yml does NOT inject it**:
   *  Production's renderer channel comes from the
   *  `import.meta.env.DEV ? "dev" : "stable"` fallback in flags.ts, and so does
   *  `pnpm dev`. Do not claim otherwise here — an earlier version of this comment
   *  said the release workflows inject "stable", which was never true. */
  readonly VITE_ZEROS_CHANNEL?: "dev" | "alpha" | "beta" | "stable";
}
