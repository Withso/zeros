// ──────────────────────────────────────────────────────────
// AuthGate — mandatory login boundary
// ──────────────────────────────────────────────────────────
//
// Renders the app only when authenticated. While the first getSession()
// resolves → a spinner; signed out → the LoginScreen; signed in → children.
//
// Placement:
//   • Desktop: between <AppearanceProvider> and <BridgeProvider> (so we don't
//     connect the engine until authenticated) — see AppShell.
//   • Web: ABOVE the pairing screen (web-app.tsx WebRoot) so the order is
//     login → pair → app. Identity-first, matching desktop.
//
// Both surfaces gate the same way; only WHERE the gate sits differs. The web
// session lives in the browser, independent of the desktop's keychain session
// — same account, separate tokens — so a returning browser with a live session
// skips straight to pairing.
// ──────────────────────────────────────────────────────────

import React from "react";
import { ZerosSpinner } from "@/loaders";
import { useAuth } from "./use-auth";
import { LoginScreen } from "./login-screen";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();

  if (status === "loading") return <AuthLoading />;
  if (status === "unauthenticated") return <LoginScreen />;
  return <>{children}</>;
}

function AuthLoading() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg1">
      <ZerosSpinner size={20} />
    </div>
  );
}
