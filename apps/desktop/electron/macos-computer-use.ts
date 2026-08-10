import {
  BrowserConfirmationBroker,
  type BrowserConfirmationDecision,
} from "./browser-confirmations";

export interface MacComputerUseDependencies {
  platform: NodeJS.Platform;
  accessibilityTrusted(prompt: boolean): boolean;
  screenPermission(): string;
  captureScreen(): Promise<{ jpeg: Buffer; width: number; height: number }>;
  click(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: MacComputerKey): Promise<void>;
}

export type MacComputerKey =
  | "enter"
  | "tab"
  | "escape"
  | "space"
  | "backspace"
  | "arrow-up"
  | "arrow-down"
  | "arrow-left"
  | "arrow-right";

export interface MacComputerUseResponse {
  success: boolean;
  contentItems: Array<
    | { type: "inputText"; text: string }
    | { type: "inputImage"; imageUrl: string }
  >;
}

const COMPUTER_ORIGIN = "https://local.system";
const VALID_KEYS = new Set<MacComputerKey>([
  "enter",
  "tab",
  "escape",
  "space",
  "backspace",
  "arrow-up",
  "arrow-down",
  "arrow-left",
  "arrow-right",
]);

/** Screenshot-driven, system-level Computer Use for macOS. Every mutating
 * action is confirmation-gated and the provider refuses to operate until both
 * Screen Recording and Accessibility are granted to Zeros. */
export class MacComputerUseProvider {
  constructor(
    private readonly deps: MacComputerUseDependencies,
    private readonly confirmations: BrowserConfirmationBroker,
  ) {}

  probe(prompt = false): {
    supported: boolean;
    accessibility: boolean;
    screenRecording: boolean;
  } {
    const supported = this.deps.platform === "darwin";
    return {
      supported,
      accessibility: supported && this.deps.accessibilityTrusted(prompt),
      screenRecording:
        supported && this.deps.screenPermission() === "granted",
    };
  }

  async requestPermissions(): Promise<{
    supported: boolean;
    accessibility: boolean;
    screenRecording: boolean;
  }> {
    const initial = this.probe(true);
    if (initial.supported && !initial.screenRecording) {
      // Electron has no separate Screen Recording prompt API. Requesting a
      // capture is the documented operation that lets macOS display it.
      await this.deps.captureScreen().catch(() => undefined);
    }
    return this.probe(false);
  }

  async execute(
    taskId: string,
    tool: string,
    args: unknown,
  ): Promise<MacComputerUseResponse> {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(taskId)) {
      return failure("Invalid Computer Use task binding.");
    }
    const readiness = this.probe(false);
    if (!readiness.supported) {
      return failure("System Computer Use is available only on macOS.");
    }
    if (!readiness.accessibility || !readiness.screenRecording) {
      return failure(
        "System Computer Use requires Accessibility and Screen Recording permissions in macOS System Settings.",
      );
    }
    const input = record(args);
    if (tool === "computer_screenshot") {
      const capture = await this.deps.captureScreen();
      return {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: JSON.stringify({
              provider: "system-computer-use",
              width: capture.width,
              height: capture.height,
              capturedAt: Date.now(),
            }),
          },
          {
            type: "inputImage",
            imageUrl: `data:image/jpeg;base64,${capture.jpeg.toString("base64")}`,
          },
        ],
      };
    }
    if (tool === "computer_click") {
      const x = coordinate(input.x, "x");
      const y = coordinate(input.y, "y");
      if (!(await this.confirm(taskId, `Click the Mac at ${x}, ${y}`))) {
        return failure("The Computer Use action was denied by the user.");
      }
      await this.deps.click(x, y);
      return success({ clicked: { x, y } });
    }
    if (tool === "computer_type") {
      const text = requiredText(input.text);
      if (text.length > 2_000) return failure("Computer Use text exceeds 2,000 characters.");
      if (!(await this.confirm(taskId, `Type ${text.length} characters into the Mac`))) {
        return failure("The Computer Use action was denied by the user.");
      }
      await this.deps.typeText(text);
      return success({ typed: true, characters: text.length });
    }
    if (tool === "computer_key") {
      const key = input.key;
      if (typeof key !== "string" || !VALID_KEYS.has(key as MacComputerKey)) {
        return failure("Unsupported Computer Use key.");
      }
      if (!(await this.confirm(taskId, `Press ${key} on the Mac`))) {
        return failure("The Computer Use action was denied by the user.");
      }
      await this.deps.pressKey(key as MacComputerKey);
      return success({ pressed: key });
    }
    return failure(`Unsupported Computer Use tool: ${tool}`);
  }

  clearTask(taskId: string): void {
    this.confirmations.clearTask(taskId);
  }

  private async confirm(
    taskId: string,
    label: string,
  ): Promise<BrowserConfirmationDecision | false> {
    const decision = await this.confirmations.confirm({
      taskId,
      category: "computer-control",
      origin: COMPUTER_ORIGIN,
      url: `${COMPUTER_ORIGIN}/control`,
      label,
    });
    return decision === "deny" ? false : decision;
  }
}

function coordinate(value: unknown, name: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 20_000
  ) {
    throw new Error(`Computer Use ${name} coordinate is invalid.`);
  }
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Computer Use text must be non-empty.");
  }
  return value;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function success(value: unknown): MacComputerUseResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}

function failure(message: string): MacComputerUseResponse {
  return {
    success: false,
    contentItems: [{ type: "inputText", text: message }],
  };
}
