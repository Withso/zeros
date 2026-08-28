import React, { memo } from "react";
import { RadioTower } from "lucide-react";

import type {
  ExecutionBoundaryPortDiscoveryIssue,
  ExecutionBoundaryPortsSnapshot,
  ExecutionBoundaryPortStatus,
} from "@zeros/protocol/containment";

import { Button } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";

export function boundaryPortLabel(port: ExecutionBoundaryPortStatus): string {
  return `localhost:${port.port}`;
}

export function boundaryPortProblemCopy(
  issue: ExecutionBoundaryPortDiscoveryIssue,
): { title: string; description: string } {
  switch (issue) {
    case "listener-inspection-failed":
      return {
        title: "Preview detection is unavailable",
        description:
          "Preview detection could not inspect this session's listeners. Restart the session to retry.",
      };
    case "listener-capacity-exceeded":
      return {
        title: "Too many preview servers",
        description:
          "Stop an unused server, then restart this session's preview detection.",
      };
    case "lease-allocation-failed":
      return {
        title: "A preview port could not be mapped",
        description:
          "Stop the conflicting server or restart the session to request a fresh mapping.",
      };
    case "policy-update-failed":
      return {
        title: "Preview access could not be refreshed",
        description: "Restart the session to rebuild preview access.",
      };
  }
}

export const BoundaryPortsPill = memo(function BoundaryPortsPill({
  snapshot,
  onOpenPort,
}: {
  snapshot: ExecutionBoundaryPortsSnapshot | null;
  onOpenPort?: (port: ExecutionBoundaryPortStatus) => void;
}) {
  if (!snapshot) return null;
  const issue = snapshot.discovery.issue;
  if (
    snapshot.ports.length === 0 &&
    !issue &&
    snapshot.discovery.state !== "discovering"
  ) {
    return null;
  }
  const count = snapshot.ports.length;
  const label =
    count === 1 ? "1 mapped port" : `${count.toString()} mapped ports`;
  const problem = issue ? boundaryPortProblemCopy(issue) : null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-fg2 hover:text-fg1 h-7 gap-1.5 px-2"
          aria-label={problem?.title ?? label}
        >
          <RadioTower size={14} aria-hidden="true" />
          {count > 0 && <span className="text-xs tabular-nums">{count}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-64">
        <DropdownMenuLabel>
          {problem?.title ?? "Session previews"}
        </DropdownMenuLabel>
        {problem && (
          <div className="text-fg2 max-w-72 px-2 pb-2 text-xs leading-5">
            {problem.description}
          </div>
        )}
        {problem && snapshot.ports.length > 0 && <DropdownMenuSeparator />}
        {snapshot.ports.map((port) => (
          <DropdownMenuItem
            key={port.id}
            disabled={!onOpenPort}
            onSelect={() => onOpenPort?.(port)}
            className="justify-between gap-4"
          >
            <span>{boundaryPortLabel(port)}</span>
            <span className="text-fg3 text-xs capitalize">
              {port.purpose.replace("-", " ")}
            </span>
          </DropdownMenuItem>
        ))}
        {snapshot.discovery.state === "discovering" && count === 0 && (
          <div className="text-fg2 px-2 py-1.5 text-xs">
            Detecting session servers…
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
