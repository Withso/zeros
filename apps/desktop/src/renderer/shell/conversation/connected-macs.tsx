import type { ReactNode } from "react";
import { ChevronDown, Laptop } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
import { IconButton } from "../../shared/ui/primitives/icon-button";
import { Switch } from "../../shared/ui/primitives/switch";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../shared/ui/primitives/dropdown-menu";
import { cn } from "../../shared/ui/cn";
import type { WorkspaceSyncStatus } from "../../../../shared/workspace-sync";
import { workspaceSyncLabel } from "../../platform/workspace-sync";

/** One of the signed-in person's own Macs, as the control plane reports it for
 * this workspace. Nobody else's devices are ever listed. */
export interface ConnectedMac {
  deviceId: string;
  name: string;
  thisMac: boolean;
  /** active: sent this workspace's latest app message (no expiry); connected:
   * connected for 12 hours from its last use; available: signed in, not connected. */
  state: "active" | "connected" | "available";
  expiresAt?: number;
  /** Separate from connected: an offline Mac is not a command target. */
  reachable: boolean;
  /** Order 3: that Mac mirrors this workspace into a local folder. */
  syncing?: boolean;
  /** 12.z: the person wants that Mac to sync it (absent from a control plane without 12.z). */
  syncWanted?: boolean;
}

/** This Mac's sync controls; main keeps the folder (the default one unless another was chosen). */
export interface ThisMacSync {
  status: WorkspaceSyncStatus | null;
  busy: boolean;
  /** The switch on: <channel folder>/cloud-sync/<repository>/<workspace> (12.zz), no picker. */
  onEnable(): void;
  onStop(): void;
  /** Choose another folder… (the native picker; sync moves there). */
  onChoose(): void;
  onOpenTerminal(): void;
  onReveal(): void;
  onCopyPath(): void;
}

export function formatExpiresIn(expiresAt: number, now: number): string {
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  if (minutes <= 0) return "expiring";
  return minutes < 60 ? `expires in ${minutes} min` : `expires in ${Math.floor(minutes / 60)} h`;
}

const stateText = (mac: ConnectedMac, now: number) => mac.state === "available" ? "Not connected"
  : (mac.state === "active" ? "Active" : `Connected · ${mac.expiresAt === undefined ? "for 12 h" : formatExpiresIn(mac.expiresAt, now)}`) + (mac.reachable ? "" : " · offline");

/** The cloud details popup's list of Macs that may run this workspace's local
 * commands. Connect works also when the workspace is not open on that Mac. */
export function ConnectedMacs({ macs, now, busyDeviceId, onConnect, onDisconnect, sync, onSetWanted }: {
  macs: readonly ConnectedMac[];
  now: number;
  busyDeviceId?: string;
  onConnect(deviceId: string): void;
  onDisconnect(deviceId: string): void;
  sync?: ThisMacSync;
  /** 12.z: another Mac's switch; that Mac starts or stops with its own default folder. */
  onSetWanted?(deviceId: string, wanted: boolean): void;
}) {
  return (
    <section aria-label="Connected Macs" className="mt-3 flex flex-col gap-2">
      <h3 className="text-fg2 text-xs leading-4.5 font-medium">Connected Macs</h3>
      {macs.length === 0 ? <p className="text-fg3 text-xs leading-4.5">No Macs signed in to this account.</p> : (
        <ul className="flex flex-col gap-1.5">
          {macs.map(mac => (
            <li key={mac.deviceId} className="flex min-w-0 flex-col gap-1">
              <div className="flex min-w-0 items-center gap-2">
              <Laptop size={14} strokeWidth={1.5} className="text-fg2 shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-fg1 flex min-w-0 items-center gap-1.5 text-xs leading-4.5">
                  <span className="truncate">{mac.name}</span>
                  {mac.thisMac && <span className="text-fg3 shrink-0">This Mac</span>}
                </span>
                <span className="text-fg3 text-xs leading-4.5">{stateText(mac, now)}</span>
              </div>
              {/* Connect is issued by that Mac itself; another Mac connects from its own app. */}
              {mac.state === "available"
                ? mac.thisMac && <Button size="compact" variant="secondary" disabled={busyDeviceId === mac.deviceId} onClick={() => onConnect(mac.deviceId)}
                    aria-label={`Connect ${mac.name}`}>Connect</Button>
                : <Button size="compact" variant="ghost" disabled={busyDeviceId === mac.deviceId} onClick={() => onDisconnect(mac.deviceId)}
                    aria-label={`Disconnect ${mac.name}`}>Disconnect</Button>}
              </div>
              {/* 12.z: a connected Mac's sync switch, as Conductor shows it under each Mac. */}
              {mac.state !== "available" && (mac.thisMac ? sync && <ThisMacSyncRow mac={mac} sync={sync} />
                : onSetWanted && <OtherMacSyncRow mac={mac} busy={busyDeviceId === mac.deviceId} onSetWanted={onSetWanted} />)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const SYNC_LABEL = "Sync to a local directory";
// The dot: green in sync, red on an error, neutral while syncing or paused.
const DOT: Record<WorkspaceSyncStatus["state"], string> = { in_sync: "bg-green-primary", error: "bg-red-primary", syncing: "bg-fg3", paused: "bg-fg3" };
/** A folder under the person's home reads from ~. */
const displayFolder = (folder: string) => folder.replace(/^\/Users\/[^/]+(?=\/|$)/, "~");

function SwitchRow({ mac, checked, disabled, onChange, children }: {
  mac: ConnectedMac; checked: boolean; disabled: boolean; onChange(value: boolean): void; children?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 pl-5" role="group" aria-label={`Sync on ${mac.name}`}>
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-fg2 min-w-0 flex-1 truncate text-xs leading-4.5">{SYNC_LABEL}</span>
        <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} aria-label={`${SYNC_LABEL} on ${mac.name}`}
          aria-description="A local copy: changes in the cloud overwrite edits made there." />
      </div>
      {children}
    </div>
  );
}

function StatusLine({ state, words }: { state: WorkspaceSyncStatus["state"]; words: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span data-sync-dot={state} className={cn("size-1.5 shrink-0 rounded-full", DOT[state])} aria-hidden="true" />
      <span role="status" className={cn(state === "error" ? "text-red-primary" : "text-fg2", "min-w-0 truncate text-xs leading-4.5")}>{words}</span>
    </span>
  );
}

/** This Mac: acts at once; on, its status and its folder with the folder's menu. */
function ThisMacSyncRow({ mac, sync }: { mac: ConnectedMac; sync: ThisMacSync }) {
  const status = sync.status;
  return (
    <SwitchRow mac={mac} checked={!!status} disabled={sync.busy} onChange={value => (value ? sync.onEnable() : sync.onStop())}>
      {status && <StatusLine state={status.state} words={workspaceSyncLabel(status)} />}
      {status?.folder && (
        <div className="border-border1 bg-bg1 flex min-w-0 items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2" data-sync-path="">
          <span className="text-fg2 min-w-0 flex-1 truncate font-mono text-3xxs leading-4.5 select-text" title={status.folder}>{displayFolder(status.folder)}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton size="compact" label="Sync folder actions" disabled={sync.busy}><ChevronDown /></IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={sync.onReveal}>Open in Finder</DropdownMenuItem>
              <DropdownMenuItem onSelect={sync.onOpenTerminal}>Open terminal here</DropdownMenuItem>
              <DropdownMenuItem onSelect={sync.onCopyPath}>Copy path</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={sync.onChoose}>Choose another folder…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </SwitchRow>
  );
}

/** Another of the person's Macs: its switch sets what that Mac should do; only
 * a control plane with 12.z (syncWanted) makes it live. No path is shown. */
function OtherMacSyncRow({ mac, busy, onSetWanted }: { mac: ConnectedMac; busy: boolean; onSetWanted: (deviceId: string, wanted: boolean) => void }) {
  const known = mac.syncWanted !== undefined;
  const wanted = mac.syncWanted ?? !!mac.syncing;
  return (
    <SwitchRow mac={mac} checked={wanted} disabled={!known || busy} onChange={value => onSetWanted(mac.deviceId, value)}>
      {mac.syncing ? <StatusLine state="syncing" words="Syncing" /> : wanted ? <StatusLine state="paused" words={mac.reachable ? "Starting on that Mac" : "Starts when that Mac is online"} /> : null}
    </SwitchRow>
  );
}
