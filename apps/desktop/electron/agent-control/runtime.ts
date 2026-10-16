// ──────────────────────────────────────────────────────────
// Agent control in Electron main
// ──────────────────────────────────────────────────────────
//
// Puts together what Zeros-owned control of the Mac shares: the approval
// broker, the computer-use controller with its control bar, simulator use,
// and the loopback service the engine calls. Main supplies the Electron,
// driver and simulator parts, so this module stays testable without them.
// ──────────────────────────────────────────────────────────

import type { AgentControlConfirmationRequest } from "@zeros/protocol/agent-control";
import {
  COMPUTER_USE_SERVICE_VERSION,
  type ComputerUseStateSnapshot,
  type ComputerUseStatus,
} from "@zeros/protocol/computer-use-tools";

import type { ComputerControlPanelHost } from "../computer-use/control-panel";
import { ComputerUseController } from "../computer-use/controller";
import type { MacComputerPermissions } from "../computer-use/permissions";
import type { ComputerDriverHost } from "../computer-use/ports";
import {
  DeviceUseController,
  type DeviceUseControllerOptions,
} from "../devices/device-use-controller";
import { AgentControlConfirmationBroker } from "./confirmations";
import {
  startAgentControlService,
  type AgentControlServiceHandle,
} from "./service";

export interface AgentControlRuntimeOptions {
  platform: NodeJS.Platform;
  /** Zeros' own process, whose windows no agent may control. */
  selfPid: number;
  host: ComputerDriverHost;
  permissions: MacComputerPermissions;
  /** The floating control bar. `onStop` is the user's Stop or Esc. */
  createPanel(onStop: () => void): ComputerControlPanelHost;
  /** This build ships the driver executable. */
  driverInstalled(): boolean;
  /** The trusted main window is there to show an approval. */
  isTrustedSurfaceAvailable(): boolean;
  onConfirmationRequest(request: AgentControlConfirmationRequest): void;
  onConfirmationSettled(confirmationId: string): void;
  onComputerState(state: ComputerUseStateSnapshot): void;
  /** Simulator use, where Zeros has simulators. Approvals go through the
   * same broker as computer use. */
  devices?: Omit<DeviceUseControllerOptions, "confirm" | "denyConfirmations">;
  startService?: typeof startAgentControlService;
  log?(message: string): void;
}

export interface AgentControlRuntime {
  readonly confirmations: AgentControlConfirmationBroker;
  readonly computer: ComputerUseController;
  /** Null without simulators. */
  readonly devices: DeviceUseController | null;
  readonly permissions: MacComputerPermissions;
  /** The engine's endpoint once it listens, or null off macOS, after a
   * failed start, or when quit came first. */
  readonly ready: Promise<AgentControlServiceHandle | null>;
  computerStatus(): ComputerUseStatus;
  /** Ask macOS for the missing grants, then report them. */
  requestComputerPermissions(): Promise<ComputerUseStatus>;
  /** The trusted window closed or reloaded: deny the approvals it showed. */
  revokeConfirmationSurface(): number;
  stop(): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAgentControlRuntime(
  options: AgentControlRuntimeOptions,
): AgentControlRuntime {
  const macOS = options.platform === "darwin";
  const confirmations: AgentControlConfirmationBroker =
    new AgentControlConfirmationBroker({
      onRequest: (request) => {
        if (!options.isTrustedSurfaceAvailable()) {
          confirmations.respond(request.id, "deny");
          return;
        }
        options.onConfirmationRequest(request);
      },
      onSettled: options.onConfirmationSettled,
    });
  let computer: ComputerUseController | null = null;
  const panel = options.createPanel(() => {
    computer?.stopFromUser();
  });
  computer = new ComputerUseController({
    host: options.host,
    permissions: options.permissions,
    panel,
    confirm: (input, signal) => confirmations.confirm(input, signal),
    denyConfirmations: (workspaceId, conversationId) => {
      confirmations.denyOwner(workspaceId, conversationId);
    },
    onState: options.onComputerState,
    selfPid: options.selfPid,
  });
  const controller = computer;
  const devices = options.devices
    ? new DeviceUseController({
        ...options.devices,
        confirm: (input, signal) => confirmations.confirm(input, signal),
        denyConfirmations: (workspaceId, conversationId) => {
          confirmations.denyOwner(workspaceId, conversationId);
        },
      })
    : null;

  let service: AgentControlServiceHandle | null = null;
  let stopping: Promise<void> | null = null;
  const startService = options.startService ?? startAgentControlService;
  const ready: Promise<AgentControlServiceHandle | null> = macOS
    ? startService({ computer: controller, ...(devices ? { device: devices } : {}) }).then(
        (handle) => {
          if (stopping) {
            void handle.stop().catch(() => undefined);
            return null;
          }
          service = handle;
          return handle;
        },
        (error: unknown) => {
          options.log?.(`agent control service unavailable: ${message(error)}`);
          return null;
        },
      )
    : Promise.resolve(null);

  const computerStatus = (): ComputerUseStatus => {
    const granted = controller.permissionStatus();
    return {
      version: COMPUTER_USE_SERVICE_VERSION,
      available: macOS && options.driverInstalled(),
      accessibility: granted.accessibility,
      screenRecording: granted.screenRecording,
    };
  };

  return {
    confirmations,
    computer: controller,
    devices,
    permissions: options.permissions,
    ready,
    computerStatus,
    async requestComputerPermissions() {
      try {
        await options.permissions.request();
      } catch (error) {
        options.log?.(
          `computer use could not ask macOS for access: ${message(error)}`,
        );
      }
      return computerStatus();
    },
    revokeConfirmationSurface() {
      return confirmations.denyPending();
    },
    stop() {
      stopping ??= (async () => {
        const handle = service;
        service = null;
        devices?.dispose();
        confirmations.denyPending();
        await Promise.allSettled([
          handle ? handle.stop() : Promise.resolve(),
          controller.dispose(),
        ]);
        panel.dispose();
      })();
      return stopping;
    },
  };
}
