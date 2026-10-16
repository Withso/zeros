// ──────────────────────────────────────────────────────────
// Agents on simulators: who may use which device, and how
// ──────────────────────────────────────────────────────────
//
// One chat uses a simulator at a time. The user allows each simulator once
// per chat and every boot on its own, and a chat's use ends on turn end,
// composer Stop, the control bar's Stop or when the device stops running.
//
// Every action names a device DeviceHub lists. Touch, text and app actions
// go to agent-device; keys, buttons, rotation and appearance go through
// DeviceHub. So do taps, presses and swipes at points that are the device's
// own, and Zeros takes screenshots of an upright screen it drives itself.
// Those take milliseconds instead of agent-device's second, so a screenshot
// waits for the screen to settle after an action, and gestures keep apart
// so that two taps never make a double tap.
// Each action holds the device off idle shutdown while it runs.
// Tool arguments never choose the runner session, its state or a file other
// than the app the agent installs.
//
// Agents work in points on every platform. agent-device takes and reports
// pixels on Android, so Android coordinates are scaled by the screen's
// density on the way in and out, and its screenshots are scaled down to
// points.
// ──────────────────────────────────────────────────────────

import type { AgentControlConfirmationDecision } from "@zeros/protocol/agent-control";
import { agentControlUnavailableReason } from "@zeros/protocol/agent-control-rollout";
import {
  agentControlName,
  isAgentControlFamily,
  isBrowserProductId,
  type AgentControlFamily,
} from "@zeros/protocol/browser-tools";
import {
  DEVICE_TOOLS_SERVICE_VERSION,
  isDeviceAppId,
  isDeviceToolName,
  parseDeviceToolCall,
  type DeviceAgentTouch,
  type DeviceAgentTouchKind,
  type DeviceToolCall,
  type DeviceToolContent,
  type DeviceToolInvokeRequest,
  type DeviceToolResult,
  type DeviceUseHolder,
  type DeviceUseReleaseRequest,
  type DeviceUseStateSnapshot,
} from "@zeros/protocol/device-tools";
import type {
  SimulatorButton,
  SimulatorDevice,
  SimulatorHubSnapshot,
  SimulatorOrientation,
  SimulatorPlatform,
  SimulatorSetupStatus,
} from "@zeros/protocol/simulators";

import type { AgentControlConfirmationInput } from "../agent-control/confirmations";
import type { AgentDeviceCommand, AgentDeviceFailure, AgentDeviceSessions } from "./agent-device";
import {
  deviceFailureText,
  formatDeviceSnapshot,
  formatInstalledApps,
  portraitPoint,
  readActionPoint,
  readDisplayRotation,
  readInstalledApps,
  readSpace,
  type DevicePoint,
  type DeviceSpace,
} from "./agent-device-output";
import {
  DeviceActionError,
  type DeviceHub,
  type DeviceOrientationPort,
  type DevicePinchPort,
} from "./device-hub";
import type { RecordedAction } from "./recording-timeline";

type NoteAction = (action: RecordedAction) => void;

export type DeviceUseHub = Pick<
  DeviceHub,
  | "state"
  | "refresh"
  | "preferences"
  | "boot"
  | "cancelBoot"
  | "canDrive"
  | "input"
  | "setAppearance"
  | "rotate"
  | "hold"
  | "deviceScreen"
>;

export type DeviceAutomation = Pick<AgentDeviceSessions, "run" | "openTarget" | "screenshot">;

/** A device's screen as Zeros reads it without agent-device. */
export interface DeviceScreenPort {
  /** A PNG of the upright screen at `size` in points, or null when the
   * screen came out turned. */
  image(deviceId: string, size: DeviceSpace): Promise<Buffer | null>;
  /** How long the device's live view has shown the same screen, in ms, or
   * null when no live view keeps up with it. */
  stillFor(deviceId: string): number | null;
}

export interface DeviceUseControllerOptions {
  hub: DeviceUseHub;
  /** Null in builds without agent-device. */
  automation: DeviceAutomation | null;
  confirm(
    input: AgentControlConfirmationInput,
    signal: AbortSignal,
  ): Promise<AgentControlConfirmationDecision>;
  denyConfirmations(workspaceId: string, conversationId: string): void;
  onState?(state: DeviceUseStateSnapshot): void;
  onTouch?(touch: DeviceAgentTouch): void;
  /** What an agent did on a device, for a recording's timeline. */
  onAction?(deviceId: string, agent: string, action: RecordedAction): void;
  /** Why an iOS app bundle can't go on a simulator, worded for the agent,
   * or null to try installing it. */
  inspectAppBundle?(path: string): Promise<string | null>;
  /** The staged simulators feature is open in this copy of Zeros. Open when
   * omitted. */
  available?(): boolean;
  /** Agents' screenshots without agent-device. */
  screen?: DeviceScreenPort;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

const MAX_REMEMBERED_CHATS = 64;
const MAX_APPROVED_DEVICES = 64;
const MAX_HOLDERS = 64;

const OFF = "Simulator use is turned off in Settings > Simulators.";
const UNAVAILABLE = "Simulators are unavailable. Restart Zeros and try again.";
const NO_AUTOMATION = "This build of Zeros can't control simulators.";
const ENDED = "Simulator use ended for this turn.";
const CANCELLED = "The simulator action was cancelled.";
const INVALID = "Invalid Zeros simulator tool request.";
const NO_BACK =
  "iOS simulators have no Back button. Tap the app's own back control, or swipe right from the screen's left edge.";
const RELEASE_REASONS = new Set(["turn-end", "stop", "retire"]);
/** As agent-device flings a swipe without a duration. */
const FLING_MS = 100;
/** Android takes taps closer together than 40 ms as one. */
const DOUBLE_TAP_GAP_MS = 100;
/** Separate taps closer together than about 350 ms make a double tap on
 * iOS, and 300 ms on Android. */
const GESTURE_GAP_MS = 400;
/** A screen the live view shows unchanged this long has settled. It is
 * also how long a device has to start answering most actions. */
const SETTLE_STILL_MS = 250;
/** iOS waits about 450 ms before answering Home or the side button, to rule
 * out a double press. */
const IOS_BUTTON_ANSWER_MS = 700;
/** Without a live view to tell, how long past its answer time an action is
 * taken to have finished moving the screen. */
const SETTLE_BLIND_MS = 350;
/** The latest after an action a screenshot waits, as for a screen that
 * keeps moving. */
const SETTLE_MAX_MS = 2_000;
const SETTLE_POLL_MS = 50;
/** A screenshot in whole points can fall short of the screen's size. */
const SCREEN_SLOP_POINTS = 2;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const BUTTON_NAMES: Record<SimulatorButton, string> = {
  home: "Home",
  lock: "Lock",
  back: "Back",
};

/** Tools agent-device performs; the rest go through DeviceHub. */
const AUTOMATION_TOOLS = new Set<DeviceToolCall["tool"]>([
  "list_apps",
  "install_app",
  "launch_app",
  "open_url",
  "snapshot",
  "screenshot",
  "tap",
  "type_text",
  "swipe",
  "scroll",
  "pinch",
]);

/** Tools that only read the device. */
const READ_TOOLS = new Set<DeviceToolCall["tool"]>(["list_apps", "snapshot", "screenshot"]);

const STATE_WORDS: Record<SimulatorDevice["state"], string> = {
  booted: "running",
  booting: "starting",
  "shutting-down": "shutting down",
  shutdown: "not running",
};

interface Holder {
  key: string;
  workspaceId: string;
  conversationId: string;
  agent: AgentControlFamily;
  turnId: string;
  deviceId: string;
  deviceName: string;
  platform: SimulatorPlatform;
  /** A boot this chat started is still running; the device isn't listed as
   * booting until DeviceHub has begun it. */
  booting: boolean;
  ended: AbortController;
  endReason: string | null;
}

/** Ends the approval cards a chat is waiting on when it is released. */
interface ChatScope {
  ended: AbortController;
  reason: string | null;
}

interface TurnDevices {
  turnId: string;
  deviceIds: Set<string>;
}

/** The latest screenshot's size, which the agent's points refer to. */
interface ScreenShape {
  space: DeviceSpace;
  orientation: SimulatorOrientation;
}

/** A device's latest action other than a read. */
interface Acted {
  /** When it ended. */
  at: number;
  /** How long the device may take to start answering it. */
  answerMs: number;
}

function ownerKey(workspaceId: string, conversationId: string): string {
  return `${workspaceId}\u0000${conversationId}`;
}

function failure(text: string): DeviceToolResult {
  return {
    version: DEVICE_TOOLS_SERVICE_VERSION,
    success: false,
    content: [{ type: "text", text }],
  };
}

function success(content: string | DeviceToolContent[]): DeviceToolResult {
  return {
    version: DEVICE_TOOLS_SERVICE_VERSION,
    success: true,
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
  };
}

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_REMEMBERED_CHATS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function validOwner(value: unknown): value is {
  workspaceId: string;
  conversationId: string;
} {
  if (!value || typeof value !== "object") return false;
  const owner = value as Record<string, unknown>;
  return isBrowserProductId(owner.workspaceId) && isBrowserProductId(owner.conversationId);
}

function deniedText(agent: AgentControlFamily, deviceName: string): string {
  return `The user did not allow ${agentControlName(agent)} to use ${deviceName}.`;
}

function bootDeniedText(agent: AgentControlFamily, deviceName: string): string {
  return `The user did not allow ${agentControlName(agent)} to start ${deviceName}.`;
}

function stoppedText(deviceName: string): string {
  return `The user stopped you on ${deviceName}. Don't use it again until the user asks.`;
}

function busyText(deviceName: string): string {
  return `Another chat is using ${deviceName}. Use another simulator, or try again when that chat finishes.`;
}

function notRunningText(device: SimulatorDevice): string {
  switch (device.state) {
    case "booting":
      return `${device.name} is still starting. Try again in a moment.`;
    case "shutting-down":
      return `${device.name} is shutting down. Try again when it has stopped.`;
    default:
      return `${device.name} isn't running. Start it with boot_device.`;
  }
}

function iosSetupText(setup: SimulatorSetupStatus | undefined): string | null {
  switch (setup?.state) {
    case "tools-missing":
      return "Xcode isn't installed, so there are no iOS simulators.";
    case "runtime-missing":
      return "Xcode has no iOS runtime yet; the user can install one from a Simulator tab.";
    case "ready":
      return "The user can add an iOS simulator in Xcode.";
    default:
      return null;
  }
}

function androidSetupText(setup: SimulatorSetupStatus | undefined): string | null {
  switch (setup?.state) {
    case "tools-missing":
      return setup.studioInstalled
        ? "Android Studio is installed without the Android Emulator."
        : "Android Studio isn't installed, so there are no Android simulators.";
    case "runtime-missing":
      return "Android Studio has no Android system image yet.";
    case "ready":
      return setup.newDevice
        ? "The user can create an Android simulator from a Simulator tab."
        : "The user can add an Android simulator in Android Studio.";
    default:
      return null;
  }
}

function noDevicesText(snapshot: SimulatorHubSnapshot): string {
  const setup = (platform: SimulatorPlatform) =>
    snapshot.setup.find((entry) => entry.platform === platform);
  const ios = setup("ios");
  if (ios?.state === "unsupported") return "Simulators need a Mac.";
  return ["This Mac has no simulators yet.", iosSetupText(ios), androidSetupText(setup("android"))]
    .filter((sentence): sentence is string => sentence !== null)
    .join(" ");
}

/** agent-device's coordinates from the agent's points. */
function toDevicePoint(point: DevicePoint, pixelsPerPoint: number): DevicePoint {
  if (pixelsPerPoint === 1) return point;
  return { x: Math.round(point.x * pixelsPerPoint), y: Math.round(point.y * pixelsPerPoint) };
}

/** The agent's points from agent-device's coordinates. */
function toAgentPoint(point: DevicePoint, pixelsPerPoint: number): DevicePoint {
  if (pixelsPerPoint === 1) return point;
  return { x: Math.round(point.x / pixelsPerPoint), y: Math.round(point.y / pixelsPerPoint) };
}

function toAgentSpace(space: DeviceSpace | null, pixelsPerPoint: number): DeviceSpace | null {
  if (!space || pixelsPerPoint === 1) return space;
  return {
    width: Math.round(space.width / pixelsPerPoint),
    height: Math.round(space.height / pixelsPerPoint),
  };
}

function screenshotResult(deviceName: string, png: Buffer, space: DeviceSpace | null): DeviceToolResult {
  const size = space ? `, ${space.width}×${space.height} points` : "";
  return success([
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    {
      type: "text",
      text: `Screenshot of ${deviceName}${size}. Use these points with tap, swipe and pinch.`,
    },
  ]);
}

function screenUnknownText(deviceName: string): string {
  return `Zeros couldn't read ${deviceName}'s screen size. Try again.`;
}

function plainLabel(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean && clean.length <= max ? clean : null;
}

function installedLabel(data: Record<string, unknown>): string {
  const bundleId = [data.bundleId, data.appId].find(isDeviceAppId) ?? null;
  const appName = plainLabel(data.appName, 120);
  if (bundleId && appName && appName !== bundleId) return `${appName} (${bundleId})`;
  return bundleId ?? "the app";
}

function characters(text: string): string {
  const count = [...text].length;
  return `${count} character${count === 1 ? "" : "s"}`;
}

export function agentDeviceOrientation(
  automation: Pick<DeviceAutomation, "run">,
): DeviceOrientationPort {
  return {
    async set(udid, orientation, deviceName) {
      const reply = await automation.run(udid, {
        name: "orientation",
        operands: [orientation],
        followFront: true,
      });
      if (reply.ok) return;
      // XCTest sets the orientation, then reports the one the device kept;
      // iPhones without a Home button never turn upside down.
      if (/device orientation is .+ expected/i.test(reply.message)) {
        throw new DeviceActionError(
          orientation === "portrait-upside-down"
            ? `${deviceName} can't turn upside down.`
            : `${deviceName} can't turn to ${orientation}.`,
        );
      }
      throw new DeviceActionError(deviceFailureText(reply, deviceName));
    },
  };
}

/** The live view's Option-drag. Without a point, agent-device pinches around
 * the screen's center, which is the same in every orientation. */
export function agentDevicePinch(automation: Pick<DeviceAutomation, "run">): DevicePinchPort {
  return {
    async pinch(udid, scale, deviceName) {
      const reply = await automation.run(udid, {
        name: "gesture",
        operands: ["pinch", String(scale)],
        followFront: true,
      });
      if (!reply.ok) throw new DeviceActionError(deviceFailureText(reply, deviceName));
    },
  };
}

export class DeviceUseController {
  private readonly holders = new Map<string, Holder>();
  private readonly chats = new Map<string, ChatScope>();
  private readonly approvals = new Map<string, Set<string>>();
  private readonly refusals = new Map<string, TurnDevices>();
  private readonly bootRefusals = new Map<string, TurnDevices>();
  private readonly stoppedTurns = new Map<string, TurnDevices>();
  private readonly approvalQueues = new Map<string, Promise<unknown>>();
  private readonly deviceQueues = new Map<string, Promise<unknown>>();
  private readonly screens = new Map<string, ScreenShape>();
  private readonly acted = new Map<string, Acted>();
  private published = "";
  private disposed = false;

  constructor(private readonly options: DeviceUseControllerOptions) {}

  state(): DeviceUseStateSnapshot {
    const holders: DeviceUseHolder[] = [...this.holders.values()]
      .slice(0, MAX_HOLDERS)
      .map((holder) => ({
        workspaceId: holder.workspaceId,
        conversationId: holder.conversationId,
        agent: holder.agent,
        deviceId: holder.deviceId,
        deviceName: holder.deviceName,
        platform: holder.platform,
      }));
    return { version: DEVICE_TOOLS_SERVICE_VERSION, holders };
  }

  async invoke(
    request: DeviceToolInvokeRequest,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DeviceToolResult> {
    if (this.disposed) return failure(UNAVAILABLE);
    if (
      request?.version !== DEVICE_TOOLS_SERVICE_VERSION ||
      !validOwner(request.owner) ||
      !isAgentControlFamily(request.agent) ||
      !isBrowserProductId(request.turnId) ||
      !isDeviceToolName(request.tool)
    ) {
      return failure(INVALID);
    }
    if (this.options.available?.() === false) {
      return failure(agentControlUnavailableReason("simulators"));
    }
    if (!this.options.hub.preferences().agentsEnabled) return failure(OFF);
    const parsed = parseDeviceToolCall(request.tool, request.arguments);
    if (!parsed.ok) return failure(parsed.error);
    const { call } = parsed;
    const key = ownerKey(request.owner.workspaceId, request.owner.conversationId);
    if (call.tool === "list_devices") return this.listDevices(key);
    if (AUTOMATION_TOOLS.has(call.tool) && !this.options.automation) {
      return failure(NO_AUTOMATION);
    }
    const deviceId = call.deviceId ?? "";
    const device = await this.findDevice(deviceId);
    if (this.disposed) return failure(UNAVAILABLE);
    if (!device) return failure(`No simulator has ID ${deviceId}. Call list_devices.`);
    if (this.turnHas(this.stoppedTurns, key, request.turnId, device.id)) {
      return failure(stoppedText(device.name));
    }
    const holder = this.holders.get(device.id);
    if (holder && holder.key !== key) return failure(busyText(device.name));
    if (call.tool === "boot_device") return this.boot(request, key, device, signal);
    if (device.state !== "booted") return failure(notRunningText(device));
    // Approval runs in order per chat and device, so calls that arrive
    // together ask once; the action then queues behind that device's others.
    const started = await this.inOrder(
      this.approvalQueues,
      `${key}\u0000${device.id}`,
      async (): Promise<{ result: Promise<DeviceToolResult> }> => {
        const problem = await this.useDevice(request, key, device, signal);
        if (typeof problem === "string") return { result: Promise.resolve(failure(problem)) };
        const current = problem;
        return {
          result: this.inOrder(this.deviceQueues, device.id, () =>
            this.perform(current, call, signal),
          ),
        };
      },
    );
    return started.result;
  }

  /** Turn end, composer Stop or conversation retirement in the engine. */
  release(request: DeviceUseReleaseRequest): boolean {
    if (
      request?.version !== DEVICE_TOOLS_SERVICE_VERSION ||
      !validOwner(request.owner) ||
      !RELEASE_REASONS.has(request.reason)
    ) {
      return false;
    }
    const { workspaceId, conversationId } = request.owner;
    const key = ownerKey(workspaceId, conversationId);
    const reason = request.reason === "stop" ? CANCELLED : ENDED;
    const chat = this.chats.get(key);
    if (chat) {
      chat.reason = reason;
      chat.ended.abort(new Error(reason));
      this.chats.delete(key);
    }
    this.options.denyConfirmations(workspaceId, conversationId);
    this.stoppedTurns.delete(key);
    this.refusals.delete(key);
    this.bootRefusals.delete(key);
    if (request.reason === "retire") this.approvals.delete(key);
    let released = false;
    for (const holder of [...this.holders.values()]) {
      if (holder.key !== key) continue;
      this.end(holder, reason);
      released = true;
    }
    return released;
  }

  /** The control bar's Stop on one simulator. Ends that chat's use at once
   * and refuses the rest of its turn there. */
  stopFromUser(deviceId: string): boolean {
    const holder = this.holders.get(deviceId);
    if (!holder) return false;
    this.addToTurn(this.stoppedTurns, holder.key, holder.turnId, deviceId);
    this.end(holder, stoppedText(holder.deviceName));
    return true;
  }

  /** DeviceHub's latest snapshot: uses of devices that stopped end. */
  syncDevices(snapshot: SimulatorHubSnapshot): void {
    const running = new Set(
      snapshot.devices
        .filter((device) => device.state === "booted" || device.state === "booting")
        .map((device) => device.id),
    );
    for (const holder of [...this.holders.values()]) {
      if (!holder.booting && !running.has(holder.deviceId)) {
        this.end(holder, `${holder.deviceName} stopped running.`);
      }
    }
    for (const deviceId of [...this.screens.keys()]) {
      if (!running.has(deviceId)) this.screens.delete(deviceId);
    }
    for (const deviceId of [...this.acted.keys()]) {
      if (!running.has(deviceId)) this.acted.delete(deviceId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const chat of this.chats.values()) {
      chat.reason = UNAVAILABLE;
      chat.ended.abort(new Error(UNAVAILABLE));
    }
    this.chats.clear();
    for (const holder of [...this.holders.values()]) this.end(holder, UNAVAILABLE);
  }

  private async listDevices(key: string): Promise<DeviceToolResult> {
    const hub = this.options.hub;
    const snapshot = await hub.refresh().catch(() => hub.state());
    const devices = snapshot.devices;
    if (devices.length === 0) return success(noDevicesText(snapshot));
    const lines = devices.map((device) => {
      const parts = [`${device.name} (${device.osLabel})`, STATE_WORDS[device.state]];
      const holder = this.holders.get(device.id);
      if (holder && holder.key !== key) parts.push("in use by another chat");
      if (device.state === "booted" && device.orientation && device.orientation !== "portrait") {
        parts.push(`turned ${device.orientation}`);
      }
      parts.push(`ID ${device.id}`);
      return `- ${parts.join(", ")}`;
    });
    return success(["Simulators on this Mac:", ...lines].join("\n"));
  }

  private async findDevice(deviceId: string): Promise<SimulatorDevice | null> {
    const hub = this.options.hub;
    const known = hub.state().devices.find((device) => device.id === deviceId);
    if (known) return known;
    const fresh = await hub.refresh().catch(() => null);
    return fresh?.devices.find((device) => device.id === deviceId) ?? null;
  }

  /** Approves the device for this chat if needed, then makes the chat its
   * holder. Returns why not, worded for the agent. */
  private async useDevice(
    request: DeviceToolInvokeRequest,
    key: string,
    device: SimulatorDevice,
    signal: AbortSignal,
  ): Promise<Holder | string> {
    const problem = await this.authorize(request, key, device, signal);
    if (problem) return problem;
    if (this.turnHas(this.stoppedTurns, key, request.turnId, device.id)) {
      return stoppedText(device.name);
    }
    return this.acquire(request, key, device) ?? busyText(device.name);
  }

  private async authorize(
    request: DeviceToolInvokeRequest,
    key: string,
    device: SimulatorDevice,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (this.approvals.get(key)?.has(device.id)) return null;
    if (this.turnHas(this.refusals, key, request.turnId, device.id)) {
      return deniedText(request.agent, device.name);
    }
    const chat = this.chat(key);
    const decision = await this.options.confirm(
      {
        kind: "device",
        workspaceId: request.owner.workspaceId,
        conversationId: request.owner.conversationId,
        agent: request.agent,
        subject: device.name,
        subjectId: device.id,
      },
      AbortSignal.any([signal, chat.ended.signal]),
    );
    if (this.disposed) return UNAVAILABLE;
    if (chat.ended.signal.aborted) return chat.reason ?? ENDED;
    if (signal.aborted) return CANCELLED;
    if (decision !== "allow") {
      this.addToTurn(this.refusals, key, request.turnId, device.id);
      return deniedText(request.agent, device.name);
    }
    this.approve(key, device.id);
    return null;
  }

  private async boot(
    request: DeviceToolInvokeRequest,
    key: string,
    device: SimulatorDevice,
    signal: AbortSignal,
  ): Promise<DeviceToolResult> {
    if (device.state === "shutting-down") return failure(notRunningText(device));
    if (device.state === "booted" || device.state === "booting") {
      const holder = await this.inOrder(this.approvalQueues, `${key}\u0000${device.id}`, () =>
        this.useDevice(request, key, device, signal),
      );
      if (typeof holder === "string") return failure(holder);
      if (device.state === "booted") return success(`${device.name} is already running.`);
      return this.awaitBoot(holder, device, signal, false);
    }
    if (this.turnHas(this.bootRefusals, key, request.turnId, device.id)) {
      return failure(bootDeniedText(request.agent, device.name));
    }
    const chat = this.chat(key);
    const decision = await this.options.confirm(
      {
        kind: "device-boot",
        workspaceId: request.owner.workspaceId,
        conversationId: request.owner.conversationId,
        agent: request.agent,
        subject: device.name,
        subjectId: device.id,
      },
      AbortSignal.any([signal, chat.ended.signal]),
    );
    if (this.disposed) return failure(UNAVAILABLE);
    if (chat.ended.signal.aborted) return failure(chat.reason ?? ENDED);
    if (signal.aborted) return failure(CANCELLED);
    if (decision !== "allow") {
      this.addToTurn(this.bootRefusals, key, request.turnId, device.id);
      return failure(bootDeniedText(request.agent, device.name));
    }
    // Starting a simulator for the agent is allowing it to use it.
    this.approve(key, device.id);
    const holder = this.acquire(request, key, device);
    if (!holder) return failure(busyText(device.name));
    return this.awaitBoot(holder, device, signal, true);
  }

  /** Waits for a boot. Only a boot this chat started is cancelled when the
   * chat stops; one the user started keeps going. */
  private async awaitBoot(
    holder: Holder,
    device: SimulatorDevice,
    signal: AbortSignal,
    ownBoot: boolean,
  ): Promise<DeviceToolResult> {
    const hub = this.options.hub;
    const scope = AbortSignal.any([signal, holder.ended.signal]);
    let stopWaiting: (value: "aborted") => void = () => undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      stopWaiting = resolve;
    });
    const onAbort = () => {
      if (ownBoot) hub.cancelBoot(device.id);
      stopWaiting("aborted");
    };
    if (scope.aborted) onAbort();
    else scope.addEventListener("abort", onAbort, { once: true });
    holder.booting = ownBoot;
    try {
      const outcome = await Promise.race([hub.boot(device.id), aborted]);
      if (outcome === "booted" && !holder.ended.signal.aborted) {
        return success(`${device.name} is running. Zeros shows it in a Simulator tab.`);
      }
      if (holder.ended.signal.aborted) return failure(holder.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      this.end(holder, ENDED);
      return failure(`Starting ${device.name} was cancelled.`);
    } catch (error) {
      if (holder.ended.signal.aborted) return failure(holder.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      this.end(holder, ENDED);
      return failure(
        error instanceof Error && error.message ? error.message : `Couldn't start ${device.name}.`,
      );
    } finally {
      holder.booting = false;
      scope.removeEventListener("abort", onAbort);
    }
  }

  private acquire(
    request: DeviceToolInvokeRequest,
    key: string,
    device: SimulatorDevice,
  ): Holder | null {
    const current = this.holders.get(device.id);
    if (current && current.key !== key) return null;
    if (current) {
      current.turnId = request.turnId;
      current.agent = request.agent;
      return current;
    }
    const holder: Holder = {
      key,
      workspaceId: request.owner.workspaceId,
      conversationId: request.owner.conversationId,
      agent: request.agent,
      turnId: request.turnId,
      deviceId: device.id,
      deviceName: device.name,
      platform: device.platform,
      booting: false,
      ended: new AbortController(),
      endReason: null,
    };
    this.holders.set(device.id, holder);
    this.publish();
    return holder;
  }

  private async perform(
    holder: Holder,
    call: DeviceToolCall,
    signal: AbortSignal,
  ): Promise<DeviceToolResult> {
    if (this.holders.get(holder.deviceId) !== holder || holder.ended.signal.aborted) {
      return failure(holder.endReason ?? ENDED);
    }
    if (signal.aborted) return failure(CANCELLED);
    const device = this.options.hub
      .state()
      .devices.find((entry) => entry.id === holder.deviceId);
    if (!device) return failure(`${holder.deviceName} is no longer available. Call list_devices.`);
    if (device.state !== "booted") return failure(notRunningText(device));
    const scope = AbortSignal.any([signal, holder.ended.signal]);
    const release = this.options.hub.hold(device.id);
    const agent = agentControlName(holder.agent);
    const note: NoteAction = (action) => {
      try {
        this.options.onAction?.(device.id, agent, action);
      } catch {
        // Timelines are a record; the action already happened.
      }
    };
    try {
      const result = await this.act(device, call, scope, note);
      if (result.success) return result;
      if (holder.ended.signal.aborted) return failure(holder.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      return result;
    } catch (error) {
      if (holder.ended.signal.aborted) return failure(holder.endReason ?? ENDED);
      if (signal.aborted) return failure(CANCELLED);
      // DeviceHub words its own failures for people.
      return failure(
        error instanceof Error && error.message ? error.message : `The action on ${device.name} failed.`,
      );
    } finally {
      if (!READ_TOOLS.has(call.tool)) {
        this.acted.set(device.id, {
          at: this.now(),
          answerMs:
            call.tool === "press_button" && device.platform === "ios"
              ? IOS_BUTTON_ANSWER_MS
              : SETTLE_STILL_MS,
        });
      }
      release();
    }
  }

  private async act(
    device: SimulatorDevice,
    call: DeviceToolCall,
    scope: AbortSignal,
    note: NoteAction,
  ): Promise<DeviceToolResult> {
    const { hub } = this.options;
    const id = device.id;
    const name = device.name;
    switch (call.tool) {
      case "press_key":
        if (!call.key) break;
        await hub.input(id, { kind: "key", key: call.key });
        note({ kind: "key", key: call.key });
        return success(`Pressed ${call.key}.`);
      case "press_button":
        if (!call.button) break;
        if (call.button === "back" && device.platform !== "android") return failure(NO_BACK);
        await hub.input(id, { kind: "button", button: call.button });
        note({ kind: "button", button: call.button });
        return success(`Pressed ${BUTTON_NAMES[call.button]}.`);
      case "rotate":
        if (!call.orientation) break;
        await hub.rotate(id, call.orientation);
        note({ kind: "rotate", orientation: call.orientation });
        return success(`Rotated ${name} to ${call.orientation}.`);
      case "set_appearance":
        if (!call.appearance) break;
        await hub.setAppearance(id, call.appearance);
        note({ kind: "appearance", appearance: call.appearance });
        return success(`${name} now uses ${call.appearance} appearance.`);
      default:
        return this.automate(device, call, scope, note);
    }
    return failure(INVALID);
  }

  private async automate(
    device: SimulatorDevice,
    call: DeviceToolCall,
    scope: AbortSignal,
    note: NoteAction,
  ): Promise<DeviceToolResult> {
    const automation = this.options.automation;
    if (!automation) return failure(NO_AUTOMATION);
    const id = device.id;
    const name = device.name;
    const android = device.platform === "android";
    const run = (command: AgentDeviceCommand) => automation.run(id, command, scope);
    const failed = (reply: AgentDeviceFailure) =>
      failure(deviceFailureText(reply, name, device.platform));
    switch (call.tool) {
      case "list_apps": {
        const reply = await run({ name: "apps", ...(call.all ? { flags: ["--all"] } : {}) });
        if (!reply.ok) return failed(reply);
        return success(formatInstalledApps(readInstalledApps(reply.data), name, call.all === true));
      }
      case "install_app": {
        if (!call.path) break;
        const apk = /\.apk$/i.test(call.path);
        if (android !== apk) {
          return failure(
            android
              ? "Android simulators install .apk files, not .app bundles."
              : "iOS simulators install .app bundles built for the iOS Simulator, not .apk files.",
          );
        }
        const problem =
          !apk && this.options.inspectAppBundle
            ? await this.options.inspectAppBundle(call.path).catch(() => null)
            : null;
        if (problem) return failure(problem);
        const reply = await run({ name: "install", operands: [call.path] });
        if (!reply.ok) return failed(reply);
        const app = installedLabel(reply.data);
        note({ kind: "install", app });
        return success(`Installed ${app} on ${name}. Open it with launch_app.`);
      }
      case "launch_app": {
        if (!call.bundleId) break;
        const reply = await automation.openTarget(
          id,
          call.bundleId,
          call.relaunch ? { relaunch: true } : {},
          scope,
        );
        if (!reply.ok) return failed(reply);
        note({ kind: "open", target: call.bundleId });
        return success(`Opened ${call.bundleId} on ${name}.`);
      }
      case "open_url": {
        if (!call.url) break;
        const reply = await automation.openTarget(id, call.url, {}, scope);
        if (!reply.ok) {
          const scheme = call.url.slice(0, call.url.indexOf(":")).toLowerCase();
          // On Android, a link no app claims fails as a bare adb error.
          if (android && reply.code === "COMMAND_FAILED" && scheme !== "http" && scheme !== "https") {
            return failure(`No app on ${name} opens ${scheme}: links.`);
          }
          return failed(reply);
        }
        note({ kind: "open", target: call.url });
        const opened = reply.data.appBundleId;
        const app = isDeviceAppId(opened) ? opened : null;
        return success(`Opened ${call.url}${app ? ` in ${app}` : ""}.`);
      }
      case "snapshot": {
        const reply = await run({
          name: "snapshot",
          ...(call.all ? {} : { flags: ["-i"] }),
          followFront: true,
        });
        if (!reply.ok) return failed(reply);
        return success(formatDeviceSnapshot(reply.data));
      }
      case "screenshot": {
        const own = await this.ownScreenshot(device, scope);
        if (own) return screenshotResult(name, own.png, own.space);
        if (scope.aborted) return failure(CANCELLED);
        const pixelsPerPoint = await this.pixelsPerPoint(device);
        if (pixelsPerPoint === null) return failure(screenUnknownText(name));
        const shot =
          pixelsPerPoint === 1
            ? await automation.screenshot(id, scope)
            : await automation.screenshot(id, scope, { scale: 1 / pixelsPerPoint });
        if (!shot.ok) return failed(shot);
        const space = readSpace(shot.data, "screenshot");
        if (space) {
          this.screens.set(id, {
            space,
            orientation: readDisplayRotation(shot.data) ?? device.orientation ?? "portrait",
          });
        }
        return screenshotResult(name, shot.png, space);
      }
      case "tap":
        return this.tap(device, call, run, note, scope);
      case "type_text": {
        const text = call.text ?? "";
        if (call.ref) {
          // agent-device drops one trailing new line from stdin.
          const reply = await run({
            name: "fill",
            flags: ["--text-stdin"],
            operands: [call.ref],
            stdin: `${text}\n`,
            followFront: true,
          });
          if (!reply.ok) return failed(reply);
          if (text) note({ kind: "text", text });
          return success(text ? `Replaced the text of ${call.ref}.` : `Cleared ${call.ref}.`);
        }
        const reply = await run({ name: "type", operands: [text], followFront: true });
        if (!reply.ok) return failed(reply);
        if (text) note({ kind: "text", text });
        return success(`Typed ${characters(text)}.`);
      }
      case "swipe": {
        if (
          call.x === undefined ||
          call.y === undefined ||
          call.toX === undefined ||
          call.toY === undefined
        ) {
          break;
        }
        const from = { x: call.x, y: call.y };
        const to = { x: call.toX, y: call.toY };
        if (await this.takesPointsAsIs(device, [from, to])) {
          if (!(await this.afterGap(id, scope))) return failure(CANCELLED);
          await this.options.hub.input(id, {
            kind: "drag",
            from,
            to,
            durationMs: call.durationMs ?? FLING_MS,
          });
        } else {
          const pixelsPerPoint = await this.pixelsPerPoint(device);
          if (pixelsPerPoint === null) return failure(screenUnknownText(name));
          const start = toDevicePoint(from, pixelsPerPoint);
          const end = toDevicePoint(to, pixelsPerPoint);
          // A timed swipe is a drag; agent-device's swipe is always a quick fling.
          const command: AgentDeviceCommand =
            call.durationMs === undefined
              ? { name: "swipe", operands: [start.x, start.y, end.x, end.y].map(String), followFront: true }
              : {
                  name: "gesture",
                  operands: [
                    "pan",
                    String(start.x),
                    String(start.y),
                    String(end.x - start.x),
                    String(end.y - start.y),
                    String(call.durationMs),
                  ],
                  followFront: true,
                };
          const reply = await run(command);
          if (!reply.ok) return failed(reply);
        }
        this.touch(device, { kind: "swipe", at: from, to });
        note({ kind: "swipe", from, to });
        return success(`Swiped from ${from.x}, ${from.y} to ${to.x}, ${to.y}.`);
      }
      case "scroll": {
        if (!call.direction) break;
        const reply = await run({
          name: "scroll",
          operands: [call.direction, ...(call.amount === undefined ? [] : [String(call.amount)])],
          followFront: true,
        });
        if (!reply.ok) return failed(reply);
        note({ kind: "scroll", direction: call.direction });
        switch (reply.data.movement) {
          case "at-edge":
            return success(`Scrolled ${call.direction} to the end of the content.`);
          case "unchanged":
            return success("The content didn't move; it may already be scrolled to the end.");
          default:
            return success(`Scrolled ${call.direction}.`);
        }
      }
      case "pinch": {
        if (call.scale === undefined) break;
        const center =
          call.x !== undefined && call.y !== undefined ? { x: call.x, y: call.y } : null;
        const pixelsPerPoint = await this.pixelsPerPoint(device);
        if (center && pixelsPerPoint === null) return failure(screenUnknownText(name));
        const around = center && pixelsPerPoint !== null ? toDevicePoint(center, pixelsPerPoint) : null;
        const reply = await run({
          name: "gesture",
          operands: [
            "pinch",
            String(call.scale),
            ...(around ? [String(around.x), String(around.y)] : []),
          ],
          followFront: true,
        });
        if (!reply.ok) return failed(reply);
        const reported = readActionPoint(reply.data);
        const at =
          center ??
          (reported && pixelsPerPoint !== null ? toAgentPoint(reported, pixelsPerPoint) : null);
        if (at) this.touch(device, { kind: "pinch", at, scale: call.scale });
        note({ kind: "pinch", scale: call.scale });
        return success(
          call.scale > 1 ? `Zoomed in to ${call.scale}×.` : `Zoomed out to ${call.scale}×.`,
        );
      }
      default:
        break;
    }
    return failure(INVALID);
  }

  private async tap(
    device: SimulatorDevice,
    call: DeviceToolCall,
    run: (command: AgentDeviceCommand) => ReturnType<DeviceAutomation["run"]>,
    note: NoteAction,
    scope: AbortSignal,
  ): Promise<DeviceToolResult> {
    const point = call.x !== undefined && call.y !== undefined ? { x: call.x, y: call.y } : null;
    if (!call.ref && !point) return failure(INVALID);
    const label = call.ref ?? `${point?.x}, ${point?.y}`;
    let kind: DeviceAgentTouchKind;
    let done: string;
    if (call.holdMs !== undefined) {
      kind = "long-press";
      done = `Long-pressed ${label} for ${call.holdMs} ms.`;
    } else if (call.count === 2) {
      kind = "double-tap";
      done = `Double-tapped ${label}.`;
    } else {
      kind = "tap";
      done = `Tapped ${label}.`;
    }
    if (point && !call.ref && (await this.takesPointsAsIs(device, [point]))) {
      const { hub } = this.options;
      if (!(await this.afterGap(device.id, scope))) return failure(CANCELLED);
      if (call.holdMs !== undefined) {
        await hub.input(device.id, { kind: "drag", from: point, to: point, durationMs: call.holdMs });
      } else {
        await hub.input(device.id, { kind: "tap", at: point });
        if (call.count === 2) {
          await this.sleep(DOUBLE_TAP_GAP_MS);
          if (scope.aborted) return failure(CANCELLED);
          await hub.input(device.id, { kind: "tap", at: point });
        }
      }
      this.touch(device, { kind, at: point });
      note({ kind, at: point });
      return success(done);
    }
    const pixelsPerPoint = await this.pixelsPerPoint(device);
    const pressAt = point && pixelsPerPoint !== null ? toDevicePoint(point, pixelsPerPoint) : null;
    const target = call.ref ? [call.ref] : pressAt ? [String(pressAt.x), String(pressAt.y)] : null;
    if (!target) return failure(screenUnknownText(device.name));
    let command: AgentDeviceCommand;
    if (call.holdMs !== undefined) {
      command = { name: "longpress", operands: [...target, String(call.holdMs)], followFront: true };
    } else if (call.count === 2) {
      command = { name: "press", flags: ["--double-tap"], operands: target, followFront: true };
    } else {
      command = { name: "press", operands: target, followFront: true };
    }
    const reply = await run(command);
    if (!reply.ok) return failure(deviceFailureText(reply, device.name, device.platform));
    // For a ref, where it landed is the element agent-device resolved.
    const pressed = readActionPoint(reply.data);
    const at =
      point ?? (pressed && pixelsPerPoint !== null ? toAgentPoint(pressed, pixelsPerPoint) : null);
    if (at) {
      this.touch(
        device,
        { kind, at },
        toAgentSpace(readSpace(reply.data, "action"), pixelsPerPoint ?? 1),
      );
    }
    note({ kind, at, ...(call.ref ? { target: call.ref } : {}) });
    return success(done);
  }

  /** Whether the agent's points are the device's own, so DeviceHub's input
   * can take them as they are, in milliseconds instead of agent-device's
   * second: the device is upright, and its latest screenshot was taken
   * upright at the size of its screen. Otherwise only agent-device knows
   * how the app in front turned. */
  private async takesPointsAsIs(
    device: SimulatorDevice,
    points: readonly DevicePoint[],
  ): Promise<boolean> {
    const { hub } = this.options;
    if ((device.orientation ?? "portrait") !== "portrait" || !hub.canDrive(device.id)) return false;
    const shot = this.screens.get(device.id);
    if (!shot || shot.orientation !== "portrait") return false;
    const { width, height } = shot.space;
    if (points.some((point) => point.x > width || point.y > height)) return false;
    const screen = await hub.deviceScreen(device.id).catch(() => null);
    if (!screen || !(screen.scale > 0)) return false;
    return (
      Math.abs(screen.widthPx / screen.scale - width) <= SCREEN_SLOP_POINTS &&
      Math.abs(screen.heightPx / screen.scale - height) <= SCREEN_SLOP_POINTS
    );
  }

  /** A screenshot Zeros takes itself, in the points DeviceHub's input takes,
   * when the device is upright and DeviceHub drives it: the frame its live
   * view shows or a capture, without agent-device's second, or its start.
   * Null when cancelled. */
  private async ownScreenshot(
    device: SimulatorDevice,
    scope: AbortSignal,
  ): Promise<{ png: Buffer; space: DeviceSpace } | null> {
    const { hub, screen } = this.options;
    if (!screen || (device.orientation ?? "portrait") !== "portrait" || !hub.canDrive(device.id)) {
      return null;
    }
    const shape = await hub.deviceScreen(device.id).catch(() => null);
    if (!shape || !(shape.scale > 0)) return null;
    const space = {
      width: Math.round(shape.widthPx / shape.scale),
      height: Math.round(shape.heightPx / shape.scale),
    };
    await this.settle(device.id, screen, scope);
    if (scope.aborted) return null;
    const png = await screen.image(device.id, space).catch(() => null);
    if (!png) return null;
    this.screens.set(device.id, { space, orientation: "portrait" });
    return { png, space };
  }

  /** Waits for what the device's latest action set off to finish, as
   * agent-device's slower screenshots did by themselves: until the device
   * had time to answer and the live view shows the screen still, or a set
   * time without one, and never longer than SETTLE_MAX_MS after the action. */
  private async settle(deviceId: string, screen: DeviceScreenPort, scope: AbortSignal): Promise<void> {
    const acted = this.acted.get(deviceId);
    if (!acted) return;
    // Bounded by count too, in case the clock jumps.
    for (let poll = 0; poll <= SETTLE_MAX_MS / SETTLE_POLL_MS; poll += 1) {
      if (scope.aborted) return;
      const since = this.now() - acted.at;
      if (since < 0 || since >= SETTLE_MAX_MS) return;
      const still = screen.stillFor(deviceId);
      const wait =
        still === null
          ? acted.answerMs + SETTLE_BLIND_MS - since
          : Math.max(acted.answerMs - since, SETTLE_STILL_MS - still);
      if (wait <= 0) return;
      await this.sleep(Math.min(wait, SETTLE_MAX_MS - since, SETTLE_POLL_MS));
    }
  }

  /** Waits out GESTURE_GAP_MS after the device's latest action. False when
   * the call ended meanwhile. */
  private async afterGap(deviceId: string, scope: AbortSignal): Promise<boolean> {
    const acted = this.acted.get(deviceId);
    const wait = acted ? Math.min(GESTURE_GAP_MS, acted.at + GESTURE_GAP_MS - this.now()) : 0;
    if (wait > 0) await this.sleep(wait);
    return !scope.aborted;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.options.sleep ?? defaultSleep)(ms);
  }

  /** agent-device's coordinates per agent point: 1 on iOS, the screen's
   * density on Android, or null when Zeros can't read the screen. */
  private async pixelsPerPoint(device: SimulatorDevice): Promise<number | null> {
    if (device.platform !== "android") return 1;
    const screen = await this.options.hub.deviceScreen(device.id).catch(() => null);
    return screen && screen.scale > 0 ? screen.scale : null;
  }

  /** Shows where the agent touched, on the portrait screen the Simulator tab
   * draws. Skipped when the agent's points can't be placed there. */
  private touch(
    device: SimulatorDevice,
    gesture: { kind: DeviceAgentTouchKind; at: DevicePoint; to?: DevicePoint; scale?: number },
    space?: DeviceSpace | null,
  ): void {
    if (!this.options.onTouch || !this.options.hub.preferences().showAgentTouches) return;
    const orientation = device.orientation ?? "portrait";
    let screen: DeviceSpace | null;
    const shot = this.screens.get(device.id);
    if (space) screen = space;
    else if (shot && shot.orientation === orientation) screen = shot.space;
    else if (orientation === "portrait") screen = null;
    // Turned, with no screenshot since: whether the app turned too is unknown.
    else return;
    const place = (point: DevicePoint) =>
      portraitPoint(point, screen, orientation, orientation === "portrait-upside-down");
    try {
      this.options.onTouch({
        deviceId: device.id,
        kind: gesture.kind,
        at: place(gesture.at),
        ...(gesture.to ? { to: place(gesture.to) } : {}),
        ...(gesture.scale === undefined ? {} : { scale: gesture.scale }),
      });
    } catch {
      // Touches are only shown; the action already happened.
    }
  }

  private chat(key: string): ChatScope {
    let chat = this.chats.get(key);
    if (!chat) {
      chat = { ended: new AbortController(), reason: null };
      remember(this.chats, key, chat);
    }
    return chat;
  }

  private approve(key: string, deviceId: string): void {
    const approved = this.approvals.get(key) ?? new Set<string>();
    if (approved.size >= MAX_APPROVED_DEVICES) approved.clear();
    approved.add(deviceId);
    remember(this.approvals, key, approved);
  }

  private turnHas(
    map: Map<string, TurnDevices>,
    key: string,
    turnId: string,
    deviceId: string,
  ): boolean {
    const entry = map.get(key);
    return entry?.turnId === turnId && entry.deviceIds.has(deviceId);
  }

  private addToTurn(
    map: Map<string, TurnDevices>,
    key: string,
    turnId: string,
    deviceId: string,
  ): void {
    const existing = map.get(key);
    const entry =
      existing?.turnId === turnId ? existing : { turnId, deviceIds: new Set<string>() };
    entry.deviceIds.add(deviceId);
    remember(map, key, entry);
  }

  private inOrder<T>(
    queues: Map<string, Promise<unknown>>,
    key: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(work, work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  }

  private end(holder: Holder, reason: string): void {
    if (holder.ended.signal.aborted) return;
    holder.endReason = reason;
    holder.ended.abort(new Error(reason));
    if (this.holders.get(holder.deviceId) === holder) this.holders.delete(holder.deviceId);
    this.publish();
  }

  private publish(): void {
    const state = this.state();
    const serialized = JSON.stringify(state);
    if (serialized === this.published) return;
    this.published = serialized;
    try {
      this.options.onState?.(state);
    } catch {
      // The renderer's copy is advisory; main stays authoritative.
    }
  }
}
