import { useLayoutEffect, useState, type ReactNode } from "react";
import type { CloudWorkspaceDocument } from "../../platform/cloud-workspaces";
import { getOrganizationStoreGeneration } from "../../features/team/team-store";
import { useCloudWorkspaceAccountAccess } from "../../features/team/cloud-workspace-account-access";
import { cloudCatalogGeneration } from "../../state/cloud-workspace-catalog";
import { Button, Popover, PopoverContent, PopoverTrigger, Tooltip } from "../../shared/ui/primitives";
import { useCloudWorkspaceSurfaceActive } from "./use-cloud-workspace-surface";

export function CloudWorkspacePopover({ workspace, active: requestedActive, label, icon, text, warm, children, align = "end" }: {
  workspace: CloudWorkspaceDocument;
  active: boolean;
  label: string;
  icon: ReactNode;
  text?: string;
  warm?: () => void;
  align?: "start" | "end";
  children: (active: boolean, close: () => void) => ReactNode;
}) {
  const internal = useCloudWorkspaceAccountAccess(workspace.organizationId);
  const active = useCloudWorkspaceSurfaceActive(requestedActive);
  const owner = JSON.stringify([getOrganizationStoreGeneration(), cloudCatalogGeneration(), workspace.organizationId, workspace.id]);
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  useLayoutEffect(() => setOpenOwner(null), [owner, active, internal]);
  const open = internal && active && openOwner === owner;
  if (!internal || workspace.placement !== "cloud" || workspace.deletedAt || ["deleting", "deleted"].includes(workspace.status)) return null;
  return <Popover open={open} onOpenChange={value => setOpenOwner(value && active ? owner : null)}>
    <Tooltip label={label}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size={text ? "default" : "icon-sm"} aria-label={label} disabled={!active}
          onPointerEnter={() => { if (active) warm?.(); }} onFocus={() => { if (active) warm?.(); }}>
          {icon}{text}
        </Button>
      </PopoverTrigger>
    </Tooltip>
    <PopoverContent align={align} sideOffset={6} className="w-[360px]" aria-label={label}>
      {open && children(open, () => setOpenOwner(null))}
    </PopoverContent>
  </Popover>;
}
