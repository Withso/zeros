// ──────────────────────────────────────────────────────────
// AuthGate — native app login boundary
// ──────────────────────────────────────────────────────────
//
// Main's stored identity opens same-account cached presentation even while a
// live token refresh is pending or offline. Until identity is known, retain the
// HTML-owned startup logo; confirmed sign-out shows LoginScreen. Explicit native
// Local development opens children without supplying an authenticated account.
//
// Placement: between <AppearanceProvider> and <BridgeProvider> in AppShell, so
// the desktop renderer does not connect to the local engine until the user is
// known to main, or main has admitted the unpackaged Local launch.
// ──────────────────────────────────────────────────────────

import React from "react";
import {
  isStartupLoaderMounted,
  StartupLogoLoader,
  useDismissStartupLoader,
} from "@/renderer/shared/ui/startup-loader";
import { useAuth } from "./use-auth";
import { LoginScreen } from "./login-screen";
import { isLocalDevelopment } from "../../platform/runtime";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status, storedUser } = useAuth();
  const localDevelopment = isLocalDevelopment();
  const ready = localDevelopment || !!storedUser || status !== "loading";

  // Keep the one HTML node alive throughout session restoration. When the
  // replacement login/app tree commits, remove it in the same layout phase so
  // there is no second loader and no blank frame between the two surfaces.
  useDismissStartupLoader(ready);

  if (localDevelopment) return <>{children}</>;
  if (storedUser) return <React.Fragment key={storedUser.accountId ?? storedUser.sub}>{children}</React.Fragment>;
  if (status === "loading") {
    // Full reloads have the HTML-owned node. This fallback covers React-only
    // remounts (Fast Refresh / error-boundary retry) after that node is gone.
    return isStartupLoaderMounted() ? null : <StartupLogoLoader />;
  }
  if (status === "unauthenticated") return <LoginScreen />;
  return <>{children}</>;
}
