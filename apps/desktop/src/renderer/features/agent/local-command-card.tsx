import { memo } from "react";
import { Terminal } from "lucide-react";
import { cn } from "../../shared/ui/cn";
import { DOCK_CARD_CLS } from "./composer-shell";
import { PermRow } from "./permission-card";

/** What this Mac is asked to run; everything here comes from the request the
 * control plane delivered to this device. */
export interface LocalCommandApproval {
  requestId: string;
  /** This Mac's name. */
  macName: string;
  workspaceName: string;
  chatTitle: string;
  command: string;
  cwd?: string;
  description?: string;
  reason?: string;
  timeoutMs: number;
  extendedTimeoutReason?: string;
  /** Set when the agent named this Mac explicitly: the Mac the chat's latest message came from. */
  explicitFrom?: string;
}
export type LocalCommandDecision = "deny" | "yes" | "always";

export function formatCommandTimeout(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  return seconds < 120 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

/** Asks this Mac's person to run one command from a cloud agent. Nothing runs
 * without one of these choices; there is no keyboard shortcut that decides,
 * only the focused button's own activation. */
export const LocalCommandApprovalCard = memo(function LocalCommandApprovalCard({ request, deciding = false, onDecide }: {
  request: LocalCommandApproval;
  deciding?: boolean;
  onDecide(decision: LocalCommandDecision): void;
}) {
  const timeout = formatCommandTimeout(request.timeoutMs) + (request.extendedTimeoutReason ? ` · ${request.extendedTimeoutReason}` : "");
  const rows = [
    { label: "Directory", value: request.cwd ?? "Home folder" },
    { label: "Timeout", value: timeout },
    ...(request.reason ? [{ label: "Reason", value: request.reason }] : []),
  ];
  return (
    <div data-local-command-card="" role="group" aria-label={`Run a command on ${request.macName}`}
      className={cn(DOCK_CARD_CLS, "flex w-full min-w-0 flex-col gap-2.5 px-3.5 py-3")}>
      <div className="text-fg1 text-xs leading-4.5 font-medium">Run this command on {request.macName}?</div>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {[request.workspaceName, request.chatTitle].map((item, index) => (
          <span key={index} className="border-border1 bg-bg1 text-fg2 max-w-full select-text truncate rounded-md border px-2 py-1 text-xs">{item}</span>
        ))}
      </div>
      {request.explicitFrom && (
        <p className="text-fg2 text-xs leading-4.5">Asked for this Mac from a chat whose latest message came from {request.explicitFrom}.</p>
      )}
      {/* The whole command, never truncated: it is what the person approves. */}
      <div className="border-border1 bg-bg1 flex min-w-0 flex-col gap-1 rounded-lg border px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Terminal className="text-fg2 size-3.5 shrink-0" aria-hidden="true" />
          {request.description && <span className="text-fg1 min-w-0 select-text truncate text-xs leading-4.5">{request.description}</span>}
        </div>
        <pre className="text-fg2 max-h-40 min-w-0 overflow-auto font-mono text-3xxs leading-4 break-all whitespace-pre-wrap select-text">{request.command}</pre>
      </div>
      <dl className="flex flex-col gap-1">
        {rows.map(row => (
          <div key={row.label} className="flex min-w-0 gap-2 text-xs leading-4.5">
            <dt className="text-fg3 shrink-0">{row.label}</dt>
            <dd className="text-fg2 min-w-0 break-all select-text">{row.value}</dd>
          </div>
        ))}
      </dl>
      <div className="-mx-2 -mb-1.5 flex flex-col gap-0.5">
        <PermRow label="Deny" hint="" disabled={deciding} onClick={() => onDecide("deny")} />
        <PermRow label="Yes" hint="" disabled={deciding} onClick={() => onDecide("yes")} />
        <PermRow label="Yes always" hint="" disabled={deciding} onClick={() => onDecide("always")} />
      </div>
    </div>
  );
});
