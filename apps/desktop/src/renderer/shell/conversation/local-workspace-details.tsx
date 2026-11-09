import { Folder, GitBranch, type LucideIcon } from "lucide-react";
import { Tooltip } from "../../shared/ui/primitives";
import { Popover, PopoverContent } from "../../shared/ui/primitives/popover";
import { useWorkspaceStore } from "../../state/workspace-store";
import { WorkspaceIdentityTrigger, useWorkspaceDetailsOpen } from "./workspace-identity";

/** A home folder reads as `~`: `/Users/<name>` on macOS, `/home/<name>` on
 * Linux and `C:\Users\<name>` on Windows. The renderer is not told the home
 * folder, so a path anywhere else, macOS's Shared folder included, is shown
 * in full; the full path is always the row's tooltip. */
export function displayFolderPath(path: string): string {
  const home = /^(?:\/Users\/(?!Shared(?:\/|$))[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=[\\/]|$)/.exec(path);
  return home ? `~${path.slice(home[0].length)}` : path;
}

function DetailRow({ Icon, label, value, tooltip, note }: {
  Icon: LucideIcon;
  label: string;
  value: string;
  tooltip?: string;
  note?: string;
}) {
  // The icon sits on the first 18px line; a note lines up under the value.
  return (
    <div className="flex min-w-0 items-start gap-2">
      <dt className="text-fg2 shrink-0 py-0.5">
        <Icon size={14} strokeWidth={1.5} className="block" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </dt>
      <dd className="min-w-0 flex-1 text-xs">
        <Tooltip label={tooltip ?? value}><span className="text-fg2 block truncate">{value}</span></Tooltip>
        {note && <span className="text-fg3 block">{note}</span>}
      </dd>
    </div>
  );
}

/** What a Local workspace is: its title (else its name), its branch when it
 * has one, and the folder it lives in on this computer. */
export function LocalWorkspaceDetailsCard({ name, title, branch, folder }: { name: string; title?: string; branch?: string; folder: string }) {
  return (
    <>
      <p className="text-fg1 mb-3 truncate text-xs leading-4.5 font-medium">{title?.trim() || name}</p>
      <dl className="space-y-2">
        {branch && <DetailRow Icon={GitBranch} label="Branch" value={branch} />}
        <DetailRow Icon={Folder} label="Folder" value={displayFolderPath(folder)} tooltip={folder} note="Local" />
      </dl>
    </>
  );
}

/** The header's name and laptop, opening the Local details. Mount it keyed by
 * folder so a switch closes the popup. */
export function LocalWorkspaceDetails({ folder, name, title, branch }: { folder: string; name: string; title?: string; branch?: string }) {
  const [shown, setOpen] = useWorkspaceDetailsOpen(useWorkspaceStore(state => state.activePage === "workspace"));
  return (
    <Popover open={shown} onOpenChange={setOpen}>
      <WorkspaceIdentityTrigger name={name} title={title} placement="local" open={shown} />
      <PopoverContent align="start" sideOffset={6} aria-label="Local workspace details">
        <LocalWorkspaceDetailsCard name={name} title={title} branch={branch} folder={folder} />
      </PopoverContent>
    </Popover>
  );
}
