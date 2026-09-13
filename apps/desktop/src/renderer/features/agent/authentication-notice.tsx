import React from "react";
import { LogIn } from "lucide-react";
import { Button } from "../../shared/ui";

/** Product state beside the prompt, outside agent output/tool groups/footers. */
export function AuthenticationNotice({
  name,
  onSignIn,
}: {
  name: string;
  onSignIn: () => void;
}) {
  return (
    <div
      className="flex flex-col items-start gap-3 py-2"
      data-authentication-notice
    >
      <p className="text-fg1 text-sm" role="status">
        Sign in to {name} in Settings, then send a new message or type
        {" “Continue” to resume."}
      </p>
      <Button variant="secondary" size="sm" onClick={onSignIn}>
        <LogIn className="size-4" aria-hidden="true" />
        Sign in
      </Button>
    </div>
  );
}
