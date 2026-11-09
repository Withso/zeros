import { useEffect, useState } from "react";
import { Cloud, Laptop } from "lucide-react";
import { Button, Tooltip } from "../../shared/ui/primitives";
import { PopoverTrigger } from "../../shared/ui/primitives/popover";

export type WorkspacePlacement = "local" | "cloud";

/** A workspace's details are ephemeral: they close when the workspace page
 * is hidden and stay closed when it returns. */
export function useWorkspaceDetailsOpen(pageActive: boolean) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!pageActive) setOpen(false);
  }, [pageActive]);
  return [open && pageActive, setOpen] as const;
}

/** The -6px margin hangs the control's 6px padding in the header's gutter. */
const IDENTITY_CLS = "text-fg1 -ml-1.5 min-w-0 max-w-full gap-1.5";

function IdentityContent({ name, placement }: { name: string; placement: WorkspacePlacement }) {
  const Icon = placement === "cloud" ? Cloud : Laptop;
  return (
    <>
      <span className="min-w-0 truncate" data-workspace-name="">{name}</span>
      <Icon className="text-fg2 size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" data-workspace-placement={placement} />
    </>
  );
}

/** The workspace's name, then where it lives: a laptop for every Local
 * workspace (branch, folder or unpublished), a cloud for cloud. One ghost
 * control inside a Popover that opens the workspace's details. */
export function WorkspaceIdentityTrigger({ name, placement, open }: {
  name: string;
  placement: WorkspacePlacement;
  open: boolean;
}) {
  return (
    <Tooltip label={name} disabled={open}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          // The Tooltip stamps its own data-state on this button, so the open
          // fill keys off aria-expanded, which only the popover sets.
          className={`${IDENTITY_CLS} aria-expanded:bg-bg2-highlight aria-expanded:text-fg1`}
          aria-label={`${name}, ${placement === "cloud" ? "Cloud" : "Local"} workspace`}
          data-workspace-identity=""
        >
          <IdentityContent name={name} placement={placement} />
        </Button>
      </PopoverTrigger>
    </Tooltip>
  );
}

/** The same name and placement with nothing to open, on the control's
 * geometry so the name does not move when details become available. */
export function WorkspaceIdentityLabel({ name, placement }: { name: string; placement: WorkspacePlacement }) {
  return (
    <Tooltip label={name}>
      <span
        className={`${IDENTITY_CLS} inline-flex items-center border border-transparent px-1.5 py-1 text-xs leading-4.5 font-medium`}
        data-workspace-identity=""
      >
        <IdentityContent name={name} placement={placement} />
      </span>
    </Tooltip>
  );
}
