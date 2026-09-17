import { ZerosSpinner } from "@/renderer/shared/ui/loading";
import type { AgentActivity } from "./agent-activity";

export function AgentActivityIndicator({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  if (!activity) return null;
  return (
    <ZerosSpinner
      size={16}
      variant={activity === "waiting" ? "orbit" : "agent"}
      label={
        activity === "waiting"
          ? "Waiting for background tasks"
          : "Agent working"
      }
      className={className}
    />
  );
}
