import React from "react";
import { LogIn } from "lucide-react";
import { Button, cn } from "../../shared/ui";
import { AGENT_NOTICE_ACTION, AgentNotice } from "./agent-notice";

/** Product state beside the prompt, outside agent output/tool groups/footers. */
export function AuthenticationNotice({
  name,
  onSignIn,
}: {
  name: string;
  onSignIn: () => void;
}) {
  return (
    <AgentNotice
      message={`Sign in to ${name} in Settings, then send a new message or type “Continue” to resume.`}
      data-authentication-notice
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onSignIn}
        className={cn(AGENT_NOTICE_ACTION, "mt-1")}
      >
        <LogIn className="size-4" aria-hidden="true" />
        Sign in
      </Button>
    </AgentNotice>
  );
}
