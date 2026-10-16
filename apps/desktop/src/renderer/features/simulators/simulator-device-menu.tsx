import { Plus } from "lucide-react";
import type { SimulatorDevice, SimulatorPlatform } from "@zeros/protocol/simulators";

import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
} from "../../shared/ui/primitives/dropdown-menu";
import { simulatorPickerSections } from "./simulator-geometry";
import { simulatorDeviceStatusLabel } from "./simulator-setup-model";

function DeviceItem({ device }: { device: SimulatorDevice }) {
  return (
    <DropdownMenuRadioItem
      value={device.id}
      indicator="check"
      disabled={device.state === "shutting-down"}
    >
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{device.name}</span>
        <span className="text-muted-fg text-2xxs truncate">
          {simulatorDeviceStatusLabel(device)}
        </span>
      </span>
    </DropdownMenuRadioItem>
  );
}

/** The device list behind "Attach simulator ▾" and the toolbar picker:
 * running devices first, then ones that boot when chosen, then a new one
 * when Zeros can make it. */
export function SimulatorDeviceMenuContent({
  devices,
  platform,
  attached,
  newDevice,
  onAttach,
  onCreate,
  onDetach,
  onShutDown,
  align = "start",
}: {
  devices: readonly SimulatorDevice[];
  platform: SimulatorPlatform;
  attached?: SimulatorDevice | null;
  newDevice?: { label: string; creating: boolean } | null;
  onAttach: (device: SimulatorDevice) => void;
  onCreate?: () => void;
  onDetach?: () => void;
  onShutDown?: (device: SimulatorDevice) => void;
  align?: "start" | "center" | "end";
}) {
  const { booted, available } = simulatorPickerSections(devices, platform);
  return (
    <DropdownMenuContent align={align} className="w-64">
      <DropdownMenuRadioGroup
        value={attached?.id ?? ""}
        onValueChange={(id) => {
          const device = devices.find((entry) => entry.id === id);
          if (device) onAttach(device);
        }}
      >
        {booted.length > 0 && (
          <DropdownMenuLabel className="text-muted-fg flex items-center gap-1.5 font-normal">
            <span aria-hidden className="bg-blue-primary size-1.5 rounded-full" />
            Booted
          </DropdownMenuLabel>
        )}
        {booted.map((device) => (
          <DeviceItem key={device.id} device={device} />
        ))}
        {booted.length > 0 && available.length > 0 && <DropdownMenuSeparator />}
        {available.length > 0 && (
          <DropdownMenuLabel className="text-muted-fg font-normal">
            Available (will boot)
          </DropdownMenuLabel>
        )}
        {available.map((device) => (
          <DeviceItem key={device.id} device={device} />
        ))}
      </DropdownMenuRadioGroup>
      {newDevice && onCreate && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={newDevice.creating} onSelect={onCreate}>
            <Plus aria-hidden />
            <span className="truncate">{newDevice.label}</span>
          </DropdownMenuItem>
        </>
      )}
      {attached && (onDetach || onShutDown) && (
        <>
          <DropdownMenuSeparator />
          {onDetach && (
            <DropdownMenuItem onSelect={onDetach}>Detach simulator</DropdownMenuItem>
          )}
          {onShutDown && attached.state === "booted" && (
            <DropdownMenuItem onSelect={() => onShutDown(attached)}>
              Shut down {attached.name}
            </DropdownMenuItem>
          )}
        </>
      )}
    </DropdownMenuContent>
  );
}
