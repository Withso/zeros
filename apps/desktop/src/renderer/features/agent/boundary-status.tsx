import React, { memo } from "react";
import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";

import type {
  ExecutionBoundaryGitStatus,
  ExecutionBoundaryServiceKind,
  ExecutionBoundaryStatus,
} from "@zeros/protocol/containment";

import { Button } from "../../shared/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../shared/ui/primitives";

const SERVICE_KIND_LABELS: Record<ExecutionBoundaryServiceKind, string> = {
  database: "Database",
  docker: "Docker",
  podman: "Podman",
  nix: "Nix",
  "ssh-agent": "SSH agent",
  "gpg-agent": "GPG agent",
  "language-daemon": "Language daemon",
  other: "Other",
};

function runtimeLabel(status: ExecutionBoundaryStatus): string {
  switch (status.backend) {
    case "zeros-srt":
      return "Zeros Sandbox Runtime";
    case "cloud-worker":
      return "Qualified cloud worker";
    case "provider-native":
      return "Provider-native fallback";
    case "none":
      return "Unavailable";
  }
}

export function boundaryStatusLabel(status: ExecutionBoundaryStatus): string {
  if (
    status.state === "draining" &&
    status.lifecycle?.lastTransition === "territory-restart"
  ) {
    return "Restarting for Design protection";
  }
  switch (status.state) {
    case "ready":
      return status.parity.level === "full"
        ? "Sandbox ready"
        : "Sandbox ready — limited parity";
    case "draining":
      return "Sandbox stopping";
    case "revoked":
      return "Sandbox stopped";
    case "unavailable":
      return "Sandbox unavailable";
    case "not-required":
      return "Sandbox not required";
  }
}

export function boundaryGitCopy(
  git: ExecutionBoundaryGitStatus | undefined,
): string {
  if (!git || git.state === "not-applicable") return "Not a Git workspace";
  switch (git.state) {
    case "ready":
      return "Private ChangeSet ready";
    case "synchronizing":
      return "Promoting changes…";
    case "clean":
      return "Clean";
    case "promoted": {
      const details: string[] = [];
      if (git.updatedRefs) {
        details.push(
          `${git.updatedRefs.toString()} ${git.updatedRefs === 1 ? "ref" : "refs"}`,
        );
      }
      if (git.indexUpdated) details.push("index");
      return details.length > 0 ? `Promoted (${details.join(", ")})` : "Promoted";
    }
    case "blocked":
      return "Blocked by a concurrent Git or Design-impact conflict";
    case "revoked":
      return "Stopped";
  }
}

export interface BoundaryStatusRow {
  label: string;
  value: string;
}

export function boundaryStatusRows(
  status: ExecutionBoundaryStatus,
): BoundaryStatusRow[] {
  const rows: BoundaryStatusRow[] = [
    { label: "Runtime", value: runtimeLabel(status) },
    {
      label: "Design",
      value: status.designProtection.required
        ? status.designProtection.enforced
          ? `Protected (${status.designProtection.protectedDirectoryCount.toString()} ${status.designProtection.protectedDirectoryCount === 1 ? "directory" : "directories"})`
          : "Protection unavailable"
        : "No active Design directory",
    },
    {
      label: "Workspace parity",
      value: status.parity.level === "full" ? "Full" : "Restricted",
    },
  ];

  if (status.services) {
    const kinds = status.services.kinds
      .map((kind) => SERVICE_KIND_LABELS[kind])
      .join(", ");
    rows.push({
      label: "Mapped services",
      value:
        status.services.activeCount === 0
          ? "None"
          : `${status.services.activeCount.toString()}${kinds ? ` (${kinds})` : ""}`,
    });
  }
  if (status.git) {
    rows.push({ label: "Private Git", value: boundaryGitCopy(status.git) });
  }
  if (status.lifecycle?.lastTransition === "territory-restart") {
    rows.push({
      label: "Lifecycle",
      value: "Restarting after Design territory changed",
    });
  }
  return rows;
}

export const BoundaryStatusPill = memo(function BoundaryStatusPill({
  status,
}: {
  status: ExecutionBoundaryStatus | null;
}) {
  if (!status) return null;
  const label = boundaryStatusLabel(status);
  const busy = status.state === "draining";
  const unhealthy =
    status.state === "unavailable" ||
    status.state === "revoked" ||
    status.git?.state === "blocked" ||
    status.parity.level === "restricted";
  const Icon = busy ? RefreshCw : unhealthy ? ShieldAlert : ShieldCheck;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-fg2 hover:text-fg1 h-7 gap-1.5 px-2"
          aria-label={label}
        >
          <Icon
            size={14}
            aria-hidden="true"
            className={busy ? "animate-spin" : undefined}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <div className="space-y-1 px-2 pb-2 text-xs leading-5">
          {boundaryStatusRows(status).map((row) => (
            <div key={row.label} className="flex justify-between gap-4">
              <span className="text-fg3">{row.label}</span>
              <span className="text-fg1 max-w-52 text-right">{row.value}</span>
            </div>
          ))}
        </div>
        {(status.remediation || status.state === "ready") && (
          <>
            <DropdownMenuSeparator />
            <div className="text-fg2 max-w-72 px-2 py-1.5 text-xs leading-5">
              {status.remediation ??
                "Code remains isolated in every workspace; Design is additionally protected when a Design directory is active."}
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
