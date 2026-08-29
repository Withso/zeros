// ──────────────────────────────────────────────────────────
// AuthGate — mandatory login boundary
// ──────────────────────────────────────────────────────────
//
// Renders the app only when authenticated. While the first getSession()
// resolves, the HTML-owned startup logo remains mounted; signed out → the
// LoginScreen; signed in → children.
//
// Placement: between <AppearanceProvider> and <BridgeProvider> in AppShell, so
// the desktop renderer does not connect to the local engine until the user is
// authenticated.
// ──────────────────────────────────────────────────────────

import React from "react";
import {
  isStartupLoaderMounted,
  StartupLogoLoader,
  useDismissStartupLoader,
} from "@/renderer/shared/ui/startup-loader";
import { useAuth } from "./use-auth";
import { LoginScreen } from "./login-screen";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const ready = status !== "loading";

  // Keep the one HTML node alive throughout session restoration. When the
  // replacement login/app tree commits, remove it in the same layout phase so
  // there is no second loader and no blank frame between the two surfaces.
  useDismissStartupLoader(ready);

  if (status === "loading") {
    // Full reloads have the HTML-owned node. This fallback covers React-only
    // remounts (Fast Refresh / error-boundary retry) after that node is gone.
    return isStartupLoaderMounted() ? null : <StartupLogoLoader />;
  }
  if (status === "unauthenticated") return <LoginScreen />;
  return <>{children}</>;
}
