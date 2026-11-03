import React from "react";
import { Check, LogIn } from "lucide-react";
import { Button, cn } from "../../shared/ui";
import { Badge } from "../../shared/ui/primitives/badge";
import { AGENT_NOTICE_ACTION, AgentNotice } from "./agent-notice";
import { cloudFailureMessage, type CloudProviderFailure } from "@zeros/protocol/cloud-v2-relay";

/** Product state beside the prompt, outside agent output/tool groups/footers. */
export function AuthenticationNotice({
  name,
  message,
  onSignIn,
  resolved = false,
  historical = false,
  cloud,
}: {
  name: string;
  message?: string;
  onSignIn: (provider?: string) => void;
  resolved?: boolean;
  historical?: boolean;
  cloud?: CloudProviderFailure;
}) {
  if (resolved || historical) {
    const Icon = resolved ? Check : LogIn;
    return <Badge variant="neutral" role="status" className="h-7 w-fit gap-2"
      data-authentication-status={resolved ? "signed-in" : "required"}>
      <Icon className="size-3.5" aria-hidden="true" />
      {resolved ? "Signed in" : "Sign-in required"}
    </Badge>;
  }
  return (
    <AgentNotice
      message={message ?? (cloud ? cloudFailureMessage(cloud) : `Sign in to ${name} in Settings, then send a new message or type “Continue” to resume.`)}
      data-authentication-notice
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={cloud ? () => onSignIn(cloud.provider) : () => onSignIn()}
        className={cn(AGENT_NOTICE_ACTION, "mt-1")}
      >
        <LogIn className="size-4" aria-hidden="true" />
        {cloud ? "Reconnect provider account" : "Sign in"}
      </Button>
    </AgentNotice>
  );
}
