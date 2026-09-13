import React from "react";
import { Check, LogIn } from "lucide-react";
import { Button, ZerosSpinner } from "../../shared/ui/primitives";
import type { SignInPhase } from "./background-signin";

export function SubscriptionSignInButton({
  phase,
  onSignIn,
}: {
  phase: SignInPhase;
  onSignIn: () => void;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      onClick={onSignIn}
      disabled={phase === "success"}
      aria-label={
        phase === "starting" || phase === "waiting"
          ? "View sign-in status"
          : undefined
      }
    >
      {phase === "starting" || phase === "waiting" ? (
        <>
          <ZerosSpinner size={16} />
          {phase === "waiting" ? "Waiting for browser sign-in…" : "Signing in…"}
        </>
      ) : phase === "success" ? (
        <>
          <Check className="size-3" strokeWidth={2} aria-hidden="true" />
          Signed in
        </>
      ) : (
        <>
          <LogIn className="size-3" strokeWidth={2} aria-hidden="true" />
          Sign in
        </>
      )}
    </Button>
  );
}
