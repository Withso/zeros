// Development-only fixture: real permission card and policy eligibility.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { RequestPermissionRequest } from "../platform/bridge/agent-events";
import { PermissionCard } from "../features/agent/permission-card";
import { permissionPolicyOption } from "../features/agent/policies";

type Scenario = {
  id: string;
  explicit?: boolean;
  focused?: boolean;
  hidden?: boolean;
};
declare global {
  interface Window {
    setPermissionFixture: (scenario: Scenario) => void;
    permissionResponses: string[];
    permissionPolicies: number;
  }
}
window.permissionResponses = [];
window.permissionPolicies = 0;

function Harness() {
  const [scenario, setScenario] = useState<Scenario>({
    id: "initial",
    explicit: true,
  });
  window.setPermissionFixture = (next) =>
    flushSync(() => {
      window.permissionResponses = [];
      window.permissionPolicies = 0;
      setScenario(next);
    });
  const request: RequestPermissionRequest = {
    sessionId: "fixture",
    nativeRequestId: scenario.id,
    requiresExplicitApproval: scenario.explicit,
    toolCall: {
      toolCallId: scenario.id,
      title: "Bash",
      kind: "execute",
      status: "pending",
      rawInput: {
        command: "rm -rf dist",
        description: "Remove generated build output",
      },
    },
    // Deliberately keep broad options to verify renderer-side enforcement too.
    options: [
      { optionId: "yes", name: "Yes", kind: "allow_once" },
      { optionId: "chat", name: "Allow for this chat", kind: "allow_always" },
      {
        optionId: "project",
        name: "Allow for this project",
        kind: "allow_always_project",
      },
      { optionId: "no", name: "No", kind: "reject_once" },
    ],
  };
  const saved = permissionPolicyOption(
    [
      {
        id: "existing-policy",
        chatId: "fixture",
        toolTitle: "Bash",
        decision: "allow",
        createdAt: 1,
      },
    ],
    request,
  );
  return (
    <main className="bg-bg1 text-fg1 min-h-screen p-6">
      <input
        aria-label="Another editor"
        className="border-border3 mb-6 border"
      />
      <section
        data-pane-root=""
        data-pane-focused={scenario.focused !== false}
        aria-hidden={scenario.hidden || undefined}
        className="max-w-3xl"
      >
        <PermissionCard
          request={request}
          chatId="fixture"
          onRecordPolicy={() => {
            window.permissionPolicies++;
          }}
          onRespond={(response) => {
            if (response.outcome.outcome === "selected")
              window.permissionResponses.push(
                `${scenario.id}:${response.outcome.optionId}`,
              );
          }}
        />
      </section>
      <output data-saved-policy="">
        {saved?.optionId ?? "requires decision"}
      </output>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
