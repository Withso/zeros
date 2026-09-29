import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import type { AgentActivity } from "./agent-activity";
import { agentTones } from "./agent-brands";

export function AgentActivityIndicator({
  activity,
  agentId,
  className,
}: {
  activity: AgentActivity;
  /** Chat tabs pass their agent so a running loader takes that logo's tones
   *  (agent-brands.ts). Everywhere else it stays one neutral colour. */
  agentId?: string | null;
  className?: string;
}) {
  if (!activity) return null;
  return (
    <ZerosSpinner
      size={16}
      variant={activity === "waiting" ? "orbit" : "agent"}
      tones={activity === "running" ? (agentTones(agentId) ?? undefined) : undefined}
      label={
        activity === "waiting"
          ? "Waiting for background tasks"
          : "Agent working"
      }
      className={className}
    />
  );
}
