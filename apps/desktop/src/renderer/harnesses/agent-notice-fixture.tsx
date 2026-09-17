import { useState } from "react";
import type { AgentMessage } from "@zeros/protocol/agent-messages";
import { AuthenticationNotice } from "../features/agent/authentication-notice";
import { TurnFailureCard } from "../features/agent/turn-failure-card";
import { turnFailureForCard } from "../features/agent/turn-failure";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import type { RendererContext } from "../features/agent/renderers/types";

const usageLimit: AgentMessage = {
  id: "usage-limit",
  kind: "error_notice",
  createdAt: 1,
  severity: "error",
  recoverable: false,
  message:
    "Error: You've hit your usage limit. Visit https://example.com/usage to purchase more credits or try again after your limit resets.",
  turnFailure: { turnId: "usage-prompt", kind: "rate-limited" },
};
const warning: AgentMessage = {
  id: "provider-warning",
  kind: "error_notice",
  createdAt: 2,
  severity: "warning",
  recoverable: true,
  message:
    "The provider is nearing its usage limit. Details: https://example.com/usage/" +
    "account-details-".repeat(12),
};
const failure = turnFailureForCard({
  events: [usageLimit],
  turnId: "usage-prompt",
  status: "failed",
})!;
const setupFailures = [
  { kind: "verification-required", message: "Claude: Complete organization verification at https://example.com/verify, then retry." },
  { kind: "cloud-credentials-unavailable", message: "Claude: Could not load Bedrock credentials. Refresh your AWS credentials and retry." },
].map(({ kind, message }) => turnFailureForCard({
  events: [], turnId: "setup-prompt", recoveryFailure: { kind, message }, status: "failed",
})!);

export function AgentNoticeFixture({ ctx }: { ctx: RendererContext }) {
  const [retries, setRetries] = useState(0);
  const [freshRetries, setFreshRetries] = useState(0);
  const [warmups, setWarmups] = useState(0);
  const [signIns, setSignIns] = useState(0);
  const [setupRetries, setSetupRetries] = useState(0);
  return (
    <section id="agent-notice-fixture" className="mx-auto w-full max-w-3xl">
      <TurnFailureCard
        failure={failure}
        onRetry={() => {
          setRetries((count) => count + 1);
          throw new Error("Retry failed. See https://example.com/support");
        }}
        onRetryNewChat={() => setFreshRetries((count) => count + 1)}
        onRetryNewChatIntent={() => setWarmups((count) => count + 1)}
      />
      <EventRowRenderer message={warning} ctx={ctx} />
      <AuthenticationNotice
        name="Agent"
        onSignIn={() => setSignIns((count) => count + 1)}
      />
      {setupFailures.map((setupFailure) => (
        <div key={setupFailure.kind} data-setup-failure={setupFailure.kind}>
          <TurnFailureCard
            failure={setupFailure}
            onRetry={() => setSetupRetries((count) => count + 1)}
            onRetryNewChat={() => setFreshRetries((count) => count + 1)}
          />
        </div>
      ))}
      <output id="agent-notice-actions" className="sr-only">
        {JSON.stringify({ retries, freshRetries, warmups, signIns, setupRetries })}
      </output>
    </section>
  );
}
