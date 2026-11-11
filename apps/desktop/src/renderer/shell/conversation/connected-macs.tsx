import { FolderSync, Laptop } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";
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
}

/** This Mac's sync controls; folders are chosen and kept by main. */
export interface ThisMacSync {
  status: WorkspaceSyncStatus | null;
  busy: boolean;
  onChoose(): void;
  onStop(): void;
  onOpenTerminal(): void;
}

export function formatExpiresIn(expiresAt: number, now: number): string {
  const minutes = Math.ceil((expiresAt - now) / 60_000);
  if (minutes <= 0) return "expiring";
  return minutes < 60 ? `expires in ${minutes} min` : `expires in ${Math.floor(minutes / 60)} h`;
}

const stateText = (mac: ConnectedMac, now: number) => mac.state === "available" ? "Not connected"
  : (mac.state === "active" ? "Active" : `Connected · ${mac.expiresAt === undefined ? "for 12 h" : formatExpiresIn(mac.expiresAt, now)}`) + (mac.reachable ? "" : " · offline");
const withSyncing = (mac: ConnectedMac, text: string) => !mac.thisMac && mac.syncing ? `${text} · Syncing` : text;

/** The cloud details popup's list of Macs that may run this workspace's local
 * commands. Connect works also when the workspace is not open on that Mac. */
export function ConnectedMacs({ macs, now, busyDeviceId, onConnect, onDisconnect, sync }: {
  macs: readonly ConnectedMac[];
  now: number;
  busyDeviceId?: string;
  onConnect(deviceId: string): void;
  onDisconnect(deviceId: string): void;
  sync?: ThisMacSync;
}) {
  return (
    <section aria-label="Connected Macs" className="mt-3 flex flex-col gap-2">
      <h3 className="text-fg2 text-xs leading-4.5 font-medium">Connected Macs</h3>
      {macs.length === 0 ? <p className="text-fg3 text-xs leading-4.5">No Macs signed in to this account.</p> : (
        <ul className="flex flex-col gap-1.5">
          {macs.map(mac => (
            <li key={mac.deviceId} className="flex min-w-0 items-center gap-2">
              <Laptop size={14} strokeWidth={1.5} className="text-fg2 shrink-0" aria-hidden="true" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="text-fg1 flex min-w-0 items-center gap-1.5 text-xs leading-4.5">
                  <span className="truncate">{mac.name}</span>
                  {mac.thisMac && <span className="text-fg3 shrink-0">This Mac</span>}
                </span>
                <span className="text-fg3 text-xs leading-4.5">{withSyncing(mac, stateText(mac, now))}</span>
              </div>
              {/* Connect is issued by that Mac itself; another Mac connects from its own app. */}
              {mac.state === "available"
                ? mac.thisMac && <Button size="compact" variant="secondary" disabled={busyDeviceId === mac.deviceId} onClick={() => onConnect(mac.deviceId)}
                    aria-label={`Connect ${mac.name}`}>Connect</Button>
                : <Button size="compact" variant="ghost" disabled={busyDeviceId === mac.deviceId} onClick={() => onDisconnect(mac.deviceId)}
                    aria-label={`Disconnect ${mac.name}`}>Disconnect</Button>}
            </li>
          ))}
        </ul>
      )}
      {sync && macs.some(mac => mac.thisMac) && <SyncRow sync={sync} />}
    </section>
  );
}

/** Off: one action. On: the status, its two actions, and a reminder that this is a copy. */
function SyncRow({ sync }: { sync: ThisMacSync }) {
  if (!sync.status) return (
    <div className="flex min-w-0 items-center gap-2">
      <FolderSync size={14} strokeWidth={1.5} className="text-fg2 shrink-0" aria-hidden="true" />
      <Button size="compact" variant="secondary" disabled={sync.busy} onClick={sync.onChoose}>Sync to a local directory</Button>
    </div>
  );
  const failed = sync.status.state === "error";
  return (
    <div role="group" aria-label="Sync on this Mac" className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        <FolderSync size={14} strokeWidth={1.5} className="text-fg2 shrink-0" aria-hidden="true" />
        <span role="status" className={`${failed ? "text-red-primary" : "text-fg1"} min-w-0 truncate text-xs leading-4.5`}>{workspaceSyncLabel(sync.status)}</span>
      </div>
      <div className="flex items-center gap-1 pl-4">
        <Button size="compact" variant="ghost" disabled={sync.busy} onClick={sync.onOpenTerminal}>Open terminal here</Button>
        <Button size="compact" variant="ghost" disabled={sync.busy} onClick={sync.onStop}>Stop sync</Button>
      </div>
      <p className="text-fg3 pl-5 text-xs leading-4.5">A local copy: changes in the cloud overwrite edits made here.</p>
    </div>
  );
}
