import { Laptop } from "lucide-react";
import { Button } from "../../shared/ui/primitives/button";

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
export function ConnectedMacs({ macs, now, busyDeviceId, onConnect, onDisconnect }: {
  macs: readonly ConnectedMac[];
  now: number;
  busyDeviceId?: string;
  onConnect(deviceId: string): void;
  onDisconnect(deviceId: string): void;
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
                <span className="text-fg3 text-xs leading-4.5">{stateText(mac, now)}</span>
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
    </section>
  );
}
