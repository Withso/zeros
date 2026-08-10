import { describe, expect, it, vi } from "vitest";

import { BrowserConfirmationBroker } from "../browser-confirmations";
import { MacComputerUseProvider } from "../macos-computer-use";

function allowingBroker(): BrowserConfirmationBroker {
  const broker = new BrowserConfirmationBroker({
    onRequest: (request) => broker.respond(request.id, "allow-once"),
  });
  return broker;
}

describe("MacComputerUseProvider", () => {
  it("requires both macOS permissions before exposing the screen", async () => {
    const provider = new MacComputerUseProvider(
      {
        platform: "darwin",
        accessibilityTrusted: () => false,
        screenPermission: () => "denied",
        captureScreen: vi.fn(),
        click: vi.fn(),
        typeText: vi.fn(),
        pressKey: vi.fn(),
      },
      allowingBroker(),
    );

    const result = await provider.execute("task-1", "computer_screenshot", {});
    expect(result.success).toBe(false);
    expect(result.contentItems[0]).toEqual(
      expect.objectContaining({ text: expect.stringMatching(/Accessibility.*Screen Recording/i) }),
    );
  });

  it("captures the screen and confirmation-gates coordinate actions", async () => {
    const click = vi.fn(async () => undefined);
    const provider = new MacComputerUseProvider(
      {
        platform: "darwin",
        accessibilityTrusted: () => true,
        screenPermission: () => "granted",
        captureScreen: async () => ({
          jpeg: Buffer.from("jpeg"),
          width: 1440,
          height: 900,
        }),
        click,
        typeText: vi.fn(async () => undefined),
        pressKey: vi.fn(async () => undefined),
      },
      allowingBroker(),
    );

    const capture = await provider.execute("task-1", "computer_screenshot", {});
    const action = await provider.execute("task-1", "computer_click", {
      x: 100,
      y: 200,
    });

    expect(capture.success).toBe(true);
    expect(capture.contentItems[1]).toEqual(
      expect.objectContaining({ type: "inputImage" }),
    );
    expect(action.success).toBe(true);
    expect(click).toHaveBeenCalledWith(100, 200);
  });

  it("does not run a mutating action when the user denies it", async () => {
    const click = vi.fn(async () => undefined);
    const broker = new BrowserConfirmationBroker({
      onRequest: (request) => broker.respond(request.id, "deny"),
    });
    const provider = new MacComputerUseProvider(
      {
        platform: "darwin",
        accessibilityTrusted: () => true,
        screenPermission: () => "granted",
        captureScreen: vi.fn(),
        click,
        typeText: vi.fn(),
        pressKey: vi.fn(),
      },
      broker,
    );

    const result = await provider.execute("task-1", "computer_click", {
      x: 10,
      y: 20,
    });

    expect(result.success).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });
});
