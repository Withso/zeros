import { Cloud } from "lucide-react";
import { isCloudWorkspace } from "../../platform/bridge/cloud-workspace-key";
import { cn } from "../../shared/ui/cn";

/** Location stays visible alongside the terminal's activity or Run icon. */
export function CloudTerminalIndicator({
  folder,
  className,
}: {
  folder?: string | null;
  className?: string;
}) {
  if (!isCloudWorkspace(folder)) return null;
  return (
    <Cloud
      role="img"
      aria-label="Cloud terminal"
      className={cn("size-3.5 shrink-0", className)}
    />
  );
}
