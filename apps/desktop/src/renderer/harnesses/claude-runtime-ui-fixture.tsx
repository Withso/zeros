// Canonical, synthetic SDK projections; engine task-runs/subagent-ownership
// regressions verify the native sequences that produce these persisted records.
import { useState } from "react";
import type { AgentMessage, AgentToolMessage } from "@zeros/protocol/agent-messages";
import { CLAUDE_ORGANIZATION_STARTUP_MESSAGES } from "@zeros/protocol/claude-startup-notice";
import { TurnEventList } from "../features/agent/turn-event-list";
import { BackgroundTaskRecord } from "../features/agent/renderers/background-task-record";
import { SubagentCard } from "../features/agent/renderers/tool-subagent";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import { AuthenticationNotice } from "../features/agent/authentication-notice";
import { authenticationFailureMessage } from "../features/agent/auth-prompt-recovery";
import { TurnFailureCard } from "../features/agent/turn-failure-card";
import { turnFailureForCard } from "../features/agent/turn-failure";
import { ProviderConnectionDialog } from "../features/settings/provider-connection-dialog";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button } from "../shared/ui/primitives/button";

const tool = (id: string, fields: Partial<AgentToolMessage>): AgentToolMessage => ({
  id: `tool-${id}`, toolCallId: id, kind: "tool", title: "Agent", toolKind: "subagent",
  status: "completed", createdAt: 1, updatedAt: 1, ...fields,
});
const organizationNotice = (code: keyof typeof CLAUDE_ORGANIZATION_STARTUP_MESSAGES): AgentMessage => ({
  id: code, kind: "error_notice", severity: "error", recoverable: false, createdAt: 1, code,
  // Native prose remains stored while the renderer chooses known reason copy.
  message: "Native organization settings service returned an error. Try to sign in.",
  turnFailure: { turnId: "startup-prompt", kind: code === "org_config_refused" ? "auth-required" : "protocol-error" },
});
const unavailable = organizationNotice("org_config_required_unavailable");
const refused = organizationNotice("org_config_refused");
const explore = tool("explore", {
  rawInput: { description: "Review the workspace", subagentType: "Explore", model: "inherit", effort: "low" },
  rawOutput: { subagentType: "Explore", resolvedModel: "claude-sonnet-5-5[1m]", effort: "high" },
});
const plan = tool("plan", {
  parentToolId: "explore", rawInput: { description: "Plan the migration", subagentType: "Plan", model: "claude-haiku-5-5", effort: "medium" },
});
const childRead = tool("child-read", {
  parentToolId: "plan", title: "Read", toolKind: "read", rawInput: { file_path: "src/router.ts" }, rawOutput: "export const routes = [];",
});

export function ClaudeRuntimeUiFixture({ ctx, connected }: { ctx: RendererContext; connected: boolean }) {
  const [startedAt] = useState(() => Date.now() - 52_000);
  const [retries, setRetries] = useState(0);
  const [signIns, setSignIns] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const nestedCtx = { ...ctx, subagentChildren: new Map<string, AgentMessage[]>([
    ["explore", [plan]], ["plan", [childRead]],
  ]) };
  // A normalized resumed projection keeps the launch row and retained feed.
  const resumedCtx = { ...ctx, subagentChildren: new Map<string, AgentMessage[]>([
    ["explore", [{ ...childRead, parentToolId: "explore" }]],
  ]) };
  const background = (runOrdinal: number, status: AgentToolMessage["status"]): AgentToolMessage => tool("stable-background-task", {
    title: "Background Task", toolKind: "background_task", status, createdAt: startedAt, updatedAt: startedAt,
    rawInput: { taskId: "b7k2m9", name: "pnpm dev --watch", command: "pnpm dev --watch", runOrdinal },
    rawOutput: { status: status === "completed" ? "completed" : "running" },
  });
  const runStates = [
    { id: "background-run-1", label: "Run 1 · running", ordinal: 1, status: "in_progress" as const, waiting: true },
    { id: "background-run-finished", label: "Run 1 · finished", ordinal: 1, status: "completed" as const, waiting: false },
    { id: "background-run-2", label: "Run 2 · resumed", ordinal: 2, status: "in_progress" as const, waiting: true },
    { id: "background-run-late", label: "Late run 1 event", ordinal: 2, status: "in_progress" as const, waiting: true },
  ];
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3" aria-label="Background task runs">
        <h2 className="text-fg1 text-sm font-medium">Background task runs</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {runStates.map(state => (
            <div id={state.id} key={state.id} className="flex min-w-0 flex-col gap-2" data-task-row-id="stable-background-task">
              <span className="text-muted-fg text-xs">{state.label}</span>
              <BackgroundTaskRecord message={background(state.ordinal, state.status)} ctx={ctx} />
              <TurnEventList events={[]} activityEvents={[background(state.ordinal, state.status)]} isActive isStreaming={false}
                activityStartedAt={startedAt} ctx={{ ...ctx, activeTurnStartedAt: startedAt }}
                backgroundTasks={state.waiting ? [{ taskId: "b7k2m9", name: "pnpm dev --watch", startedAt: Date.now() - 12_000, updatedAt: startedAt }] : []} />
            </div>
          ))}
        </div>
      </section>
      <section className="flex flex-col gap-3" aria-label="Claude agents">
        <h2 className="text-fg1 text-sm font-medium">Claude agents</h2>
        <div id="claude-agent-metadata"><SubagentCard message={explore} ctx={ctx} /></div>
        <div id="claude-agent-missing-metadata"><SubagentCard message={tool("missing", { rawInput: { description: "Inspect the source" } })} ctx={ctx} /></div>
        <div id="claude-agent-nested"><SubagentCard message={explore} ctx={nestedCtx} /></div>
        <div id="claude-agent-resumed"><SubagentCard message={{ ...explore, status: "in_progress" }} ctx={resumedCtx} /></div>
        <div id="claude-background-agent"><BackgroundTaskRecord message={tool("background-agent", {
          title: "Background Task", toolKind: "background_task", status: "in_progress",
          rawInput: { taskId: "agent-task", name: "Audit flaky tests", subagentType: "Explore" }, rawOutput: { status: "running" },
        })} ctx={ctx} /></div>
      </section>
      <section className="flex flex-col gap-3" aria-label="Claude startup notices">
        <h2 className="text-fg1 text-sm font-medium">Claude startup notices</h2>
        <div id="claude-org-unavailable"><TurnFailureCard failure={turnFailureForCard({ events: [unavailable], turnId: "startup-prompt", status: "failed" })!}
          onRetry={() => setRetries(count => count + 1)} onRetryNewChat={() => { throw new Error("Organization settings require retry in the same conversation"); }} /></div>
        <div id="claude-org-refused"><AuthenticationNotice name="Claude Code" message={authenticationFailureMessage([refused])}
          onSignIn={() => setSignIns(count => count + 1)} /></div>
        <Button id="claude-provider-connection" variant="secondary" onClick={() => setConnectionOpen(true)}>Show Claude connection</Button>
        <ProviderConnectionDialog provider="claude" name="Claude Code" open={connectionOpen} onOpenChange={setConnectionOpen}
          method="account" onMethodChange={() => {}} connected={connected} busy={false}>
          <span className="text-fg2 text-xs">{connected ? "Claude is connected." : "Connect Claude in Settings."}</span>
        </ProviderConnectionDialog>
        <output id="claude-startup-actions" className="sr-only">{JSON.stringify({ retries, signIns, connected })}</output>
      </section>
      <section id="claude-chrome-setup" className="flex flex-col gap-3" aria-label="Claude Chrome setup">
        <h2 className="text-fg1 text-sm font-medium">Claude Chrome setup</h2>
        <EventRowRenderer message={tool("chrome-setup", { title: "Chrome setup", toolKind: "other", rawInput: { reason: "Test checkout in your browser" }, rawOutput: { outcome: "not_now" } })} ctx={ctx} />
        <EventRowRenderer message={{ id: "chrome-notice", kind: "error_notice", createdAt: 1, severity: "warning", recoverable: true,
          code: "claude-chrome-setup", message: "Set up Claude in Chrome in Settings to let Claude use your browser." }} ctx={ctx} />
      </section>
    </div>
  );
}
