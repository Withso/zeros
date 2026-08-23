// ──────────────────────────────────────────────────────────
// LoginScreen — sign in via the browser
// ──────────────────────────────────────────────────────────
//
// Rendered by <AuthGate> when signed out. Electron main owns WorkOS PKCE, binds
// an ephemeral loopback callback, and stores the resulting rotating token pair;
// this renderer only waits for a metadata-only completion event. The legacy
// Auth0 web-ticket/deep-link flow remains selectable until Phase 5.
//
// On click the button switches to "Opening browser…" (animated dots) and stays
// there for the whole browser round-trip, with a Cancel affordance beneath it.
//
// Transient feedback is INLINE here by design (calmer than toasts while the
// browser round-trip is in flight). The app Toaster now lives ABOVE the gate
// (AppShell), so app-level toasts — e.g. "New update available" — do appear
// over this screen.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "@/renderer/shared/ui";
import { useAuth } from "./use-auth";
import { isElectron, nativeInvoke } from "../../platform/runtime";

const PRIVACY_URL = "https://zeros.build/privacy";
const TERMS_URL = "https://zeros.build/terms";

/** Open a URL in the user's real browser (desktop) / a new tab (web). */
function openExternal(url: string): void {
  if (isElectron()) void nativeInvoke("shell_open_url", { url });
  else globalThis.open?.(url, "_blank", "noopener,noreferrer");
}

export function LoginScreen() {
  const {
    startBrowserSignIn,
    cancelPendingOAuth,
    oauthError,
    clearOAuthError,
  } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Desktop sign-in in flight: the system browser is open and we're waiting for
  // either the main-owned loopback callback or legacy deep link to flip the gate.
  const [waiting, setWaiting] = useState(false);

  // "Opening browser…" covers both the brief startBrowserSignIn call (busy) and
  // the subsequent wait for the deep-link handoff (waiting).
  const pending = busy || waiting;

  // A failed handoff (nonce expired / redeem failed) arrives asynchronously as
  // oauthError — leave the waiting state so the error + a retry are shown.
  useEffect(() => {
    if (oauthError && waiting) setWaiting(false);
  }, [oauthError, waiting]);

  async function onSignIn() {
    if (pending) return;
    setError(null);
    clearOAuthError();
    setBusy(true);
    const res = await startBrowserSignIn();
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? "Couldn't start sign-in.");
      return;
    }
    // Desktop: the system browser opened — stay "Opening browser…" until the
    // deep-link handoff flips the gate (or the user cancels / it times out).
    // Web: a full-page navigation is already in flight; this screen unmounts.
    if (isElectron()) setWaiting(true);
  }

  function cancelWaiting() {
    cancelPendingOAuth();
    setWaiting(false);
  }

  return (
    <div className="bg-bg1 text-fg2 fixed inset-0 z-50 flex flex-col">
      {/* main content — three rows (logo · prompt · button) with EQUAL gaps,
          left-aligned within a centered column. */}
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="flex w-full max-w-[340px] flex-col items-start gap-6">
          <ZerosLogo />
          <p className="text-fg2 text-sm">Sign in or sign up to continue</p>
          <div className="flex flex-col items-start gap-3">
            <Button
              variant="primary"
              className="bg-primary-button-bg text-primary-button-fg hover:bg-primary-button-hover gap-2 text-sm disabled:opacity-100"
              onClick={onSignIn}
              loading={pending}
            >
              {pending ? (
                <>
                  <span>
                    Opening browser
                    <OpeningDots />
                  </span>
                  <ArrowRight className="size-4" />
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>
            {/* A start failure (couldn't open the browser) or a FAILED browser
                handoff (oauthError, async after the round-trip) shows here. */}
            {(error || oauthError) && (
              <p className="text-red-primary text-sm">{error ?? oauthError}</p>
            )}
            {/* While the browser is open: a Cancel affordance. */}
            {waiting && (
              <button
                type="button"
                onClick={cancelWaiting}
                className="text-fg2 hover:text-fg1 text-sm transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
      {/* Privacy + Terms — centered along the bottom. */}
      <div className="flex items-center justify-center gap-6 pb-8">
        <LegalLink onClick={() => openExternal(PRIVACY_URL)}>Privacy</LegalLink>
        <LegalLink onClick={() => openExternal(TERMS_URL)}>
          Terms &amp; Conditions
        </LegalLink>
      </div>
    </div>
  );
}

// ── presentational helpers ──────────────────────────────────────────────────

/** Zeros mark in a bordered tile + the "zeros" wordmark (split from
 *  ZEROS-logo-name.svg so the icon can sit in its own --border2 tile, matching
 *  the brand lockup). Both render in currentColor (fg1) so they track the theme. */
function ZerosLogo() {
  return (
    <div className="text-fg1 flex items-center gap-4">
      <div className="border-border2 flex size-14 items-center justify-center rounded-lg border">
        <svg
          viewBox="0 0 49 59"
          className="h-8 w-auto"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M23.3929 10.5C23.3929 16.299 18.6919 21 12.8929 21C7.09394 21 2.39293 16.299 2.39293 10.5C2.39293 4.70101 7.09394 0 12.8929 0C18.6919 0 23.3929 4.70101 23.3929 10.5Z" />
          <path d="M26.3929 48.5C26.3929 54.299 31.0939 59 36.8929 59C42.6919 59 47.3929 54.299 47.3929 48.5C47.3929 42.701 42.6919 38 36.8929 38C31.0939 38 26.3929 42.701 26.3929 48.5Z" />
          <path d="M2.39293 33C4.84439 28.0971 9.91128 25 15.3929 25C19.3348 25 21.9903 30.0924 21.0062 33.9094C20.0582 37.5865 19.8631 42.1285 21.8929 47C24.2715 52.7086 20.0773 59 13.8929 59H11.8962C8.46974 59 5.25271 57.261 3.58328 54.2688C2.96468 53.16 2.35657 52.0087 1.89293 51C1.68581 50.5494 1.46901 50.0321 1.24917 49.4751C-0.860721 44.1296 -0.177121 38.1401 2.39293 33Z" />
          <path d="M45.3815 7.77333C42.9019 3.25165 38.259 0.335058 33.1092 0.0640141C32.2997 0.0214092 31.4881 0.0449828 30.6824 0.1345L30.0188 0.208231C27.0882 0.533854 25.4849 4.37217 26.564 7.11624C28.0356 10.8581 28.8672 16.0617 26.3929 22C24.0143 27.7086 28.2086 34 34.3929 34H35.9314C39.8442 34 43.3732 31.6473 44.8781 28.0355L46.7502 23.5425C48.7365 18.7754 48.4472 13.3637 45.964 8.83554L45.3815 7.77333Z" />
        </svg>
      </div>
      <svg
        viewBox="75.77 0 279.4 59"
        className="h-7 w-auto"
        fill="currentColor"
        role="img"
        aria-label="Zeros"
      >
        <path d="M127.137 7.44V18.32L101.457 38.64H128.097V52H75.7774V41.04L101.457 20.72H76.8974V7.44H127.137Z" />
        <path d="M150.799 33.6C152.239 39.12 156.959 41.2 164.719 41.2C171.359 41.2 175.119 39.68 179.359 36.64L188.479 46.08C182.079 51.76 173.679 53.84 163.679 53.84C144.239 53.84 132.959 44.8 132.959 29.68C132.959 14.72 144.159 5.52 162.239 5.52C178.239 5.52 190.239 13.44 190.239 29.2C190.239 31.2 189.999 32.48 189.679 33.6H150.799ZM162.399 18C156.799 18 152.799 20.08 151.199 24.56L173.199 24.48C171.679 20.24 168.159 18 162.399 18Z" />
        <path d="M216.27 52H197.391V7.44H216.27V14.88C219.95 8.96 226.35 6.32 233.79 6.32V21.76C224.51 21.76 218.19 25.2 216.27 32V52Z" />
        <path d="M266.391 53.84C248.231 53.84 236.631 44.72 236.631 29.68C236.631 14.72 248.231 5.6 266.391 5.6C284.551 5.6 296.151 14.72 296.151 29.68C296.151 44.72 284.551 53.84 266.391 53.84ZM266.391 39.84C273.351 39.84 278.311 36.24 278.311 29.68C278.311 23.12 273.351 19.6 266.391 19.6C259.511 19.6 254.471 23.12 254.471 29.68C254.471 36.24 259.511 39.84 266.391 39.84Z" />
        <path d="M329.49 22.56C343.89 23.28 355.17 27.44 355.17 37.52C355.17 46.4 346.61 53.84 328.37 53.84C316.13 53.84 306.29 50.4 299.81 46.08L307.49 36.48C312.53 39.6 319.73 42.08 328.93 42.08C334.45 42.08 337.57 41.44 337.57 39.36C337.57 37.44 334.77 36.8 327.49 36.32C314.45 35.6 301.65 31.6 301.65 21.28C301.65 11.84 311.97 5.52 328.21 5.52C338.13 5.52 347.17 7.68 353.41 11.28L345.73 21.2C341.17 18.64 335.09 17.36 327.97 17.36C323.41 17.36 319.17 17.84 319.17 19.92C319.17 21.84 322.69 22.16 329.49 22.56Z" />
      </svg>
    </div>
  );
}

/** Animated "…" for the "Opening browser…" label — three dots fade in sequence.
 *  Always three dots (no layout shift); the keyframe lives in
 *  styles/global/animations.css. */
function OpeningDots() {
  return (
    <span aria-hidden="true">
      <span className="[animation:zeros-ellipsis-dot_1.4s_ease-in-out_0s_infinite]">
        .
      </span>
      <span className="[animation:zeros-ellipsis-dot_1.4s_ease-in-out_0.2s_infinite]">
        .
      </span>
      <span className="[animation:zeros-ellipsis-dot_1.4s_ease-in-out_0.4s_infinite]">
        .
      </span>
    </span>
  );
}

function LegalLink({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-fg2 hover:text-fg1 text-sm transition-colors hover:underline"
    >
      {children}
    </button>
  );
}
