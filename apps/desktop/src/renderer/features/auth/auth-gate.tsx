// ──────────────────────────────────────────────────────────
// AuthGate — mandatory login boundary
// ──────────────────────────────────────────────────────────
//
// Renders the app only when authenticated. While the first getSession()
// resolves → a spinner; signed out → the LoginScreen; signed in → children.
//
// Placement: between <AppearanceProvider> and <BridgeProvider> in AppShell, so
// the desktop renderer does not connect to the local engine until the user is
// authenticated.
// ──────────────────────────────────────────────────────────

import React from "react";
import { ZerosSpinner } from "@/renderer/shared/ui/loading";
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
    <div className="bg-bg1 fixed inset-0 z-50 flex items-center justify-center">
      <ZerosSpinner size={20} />
    </div>
  );
}
