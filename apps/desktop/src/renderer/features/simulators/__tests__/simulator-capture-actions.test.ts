import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SimulatorCapture, SimulatorCaptureFile } from "@zeros/protocol/simulator-captures";

const api = vi.hoisted(() => ({
  takeSimulatorScreenshot: vi.fn<(deviceId: string) => Promise<SimulatorCapture>>(),
  startSimulatorRecording: vi.fn<(deviceId: string) => Promise<unknown>>(),
  stopSimulatorRecording: vi.fn<(deviceId: string) => Promise<SimulatorCapture>>(),
  loadSimulatorCaptureFile: vi.fn<(captureId: string) => Promise<SimulatorCaptureFile>>(),
  dragSimulatorCapture: vi.fn<(captureId: string) => Promise<void>>(),
  loadSimulatorRecordings: vi.fn(),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const delivery = vi.hoisted(() => ({ deliverFilesToChat: vi.fn() }));
const focus = vi.hoisted(() => ({ version: 0 }));

vi.mock("../simulator-api", () => api);
vi.mock("../../../shared/ui/primitives/elements", () => ({ toast: toasts }));
vi.mock("../../agent/composer-file-attachment-delivery", () => delivery);
vi.mock("../../../shared/ui/focus-navigation", () => ({ getFocusInteractionVersion: () => focus.version }));

import {
  addSimulatorCaptureToChat,
  dragSimulatorCaptureFile,
  showRecordingEnd,
  startRecordingFromTab,
  stopRecordingFromTab,
  takeScreenshotFromTab,
} from "../simulator-capture-actions";
import {
  captureThumbnails,
  listenToSimulatorFlashes,
  resetSimulatorCapturesForTests,
} from "../simulator-capture-store";

const PHONE = { id: "FBF8387E-9B7A-4F2A-9ACE-6BDF338E0108", name: "iPhone 17" };

const SCREENSHOT: SimulatorCapture = {
  id: "capture-1",
  kind: "screenshot",
  deviceId: PHONE.id,
  deviceName: PHONE.name,
  fileName: "Simulator Screenshot - iPhone 17.png",
  thumbnail: null,
};

const RECORDING: SimulatorCapture = {
  id: "capture-2",
  kind: "recording",
  deviceId: PHONE.id,
  deviceName: PHONE.name,
  fileName: "Simulator Screen Recording - iPhone 17.mp4",
  thumbnail: null,
  durationMs: 12_000,
};

const shown = () => captureThumbnails.current().map((capture) => capture.id);

beforeEach(() => {
  resetSimulatorCapturesForTests();
  for (const mock of [...Object.values(api), ...Object.values(toasts)]) mock.mockReset();
  delivery.deliverFilesToChat.mockReset();
  focus.version = 0;
  api.dragSimulatorCapture.mockResolvedValue(undefined);
});

describe("simulator screenshots", () => {
  it("flashes the screen as it asks main, then shows the saved file", async () => {
    const order: string[] = [];
    listenToSimulatorFlashes(PHONE.id, () => order.push("flash"));
    api.takeSimulatorScreenshot.mockImplementation(async () => {
      order.push("screenshot");
      return SCREENSHOT;
    });
    await expect(takeScreenshotFromTab(PHONE)).resolves.toBe(true);
    expect(order).toEqual(["flash", "screenshot"]);
    expect(api.takeSimulatorScreenshot).toHaveBeenCalledWith(PHONE.id);
    expect(shown()).toEqual(["capture-1"]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("says why a screenshot failed, in main's words", async () => {
    api.takeSimulatorScreenshot.mockRejectedValue(new Error("iPhone 17 isn't running."));
    await expect(takeScreenshotFromTab(PHONE)).resolves.toBe(false);
    expect(toasts.error).toHaveBeenCalledWith("iPhone 17 isn't running.", {
      id: `simulator-screenshot:${PHONE.id}`,
    });
    api.takeSimulatorScreenshot.mockRejectedValue("boom");
    await takeScreenshotFromTab(PHONE);
    expect(toasts.error).toHaveBeenLastCalledWith("Couldn't take a screenshot of iPhone 17.", {
      id: `simulator-screenshot:${PHONE.id}`,
    });
    expect(shown()).toEqual([]);
  });
});

describe("simulator recordings", () => {
  it("starts, and on Stop shows the saved video", async () => {
    api.startSimulatorRecording.mockResolvedValue({ deviceId: PHONE.id, startedAt: 1 });
    api.stopSimulatorRecording.mockResolvedValue(RECORDING);
    await expect(startRecordingFromTab(PHONE)).resolves.toBe(true);
    await expect(stopRecordingFromTab(PHONE)).resolves.toBe(true);
    expect(api.startSimulatorRecording).toHaveBeenCalledWith(PHONE.id);
    expect(api.stopSimulatorRecording).toHaveBeenCalledWith(PHONE.id);
    expect(shown()).toEqual(["capture-2"]);
  });

  it("toasts a recording that couldn't start or be saved under one id", async () => {
    api.startSimulatorRecording.mockRejectedValue(new Error("Recording needs Xcode 26."));
    api.stopSimulatorRecording.mockRejectedValue(new Error(""));
    await expect(startRecordingFromTab(PHONE)).resolves.toBe(false);
    await expect(stopRecordingFromTab(PHONE)).resolves.toBe(false);
    const id = `simulator-recording:${PHONE.id}`;
    expect(toasts.error.mock.calls).toEqual([
      ["Recording needs Xcode 26.", { id }],
      ["Couldn't save the recording of iPhone 17.", { id }],
    ]);
    expect(shown()).toEqual([]);
  });

  it("shows a recording that ended on its own, saying why", () => {
    showRecordingEnd({ deviceId: PHONE.id, reason: "device", capture: RECORDING });
    expect(shown()).toEqual(["capture-2"]);
    expect(toasts.info).toHaveBeenCalledWith("iPhone 17 stopped, so its recording ended", {
      id: `simulator-recording:${PHONE.id}`,
      description: "The video is in Downloads.",
    });
  });

  it("shows only main's sentence for a video that couldn't be saved", () => {
    showRecordingEnd({
      deviceId: PHONE.id,
      reason: "exited",
      error: "Couldn't save the recording of iPhone 17.",
    });
    expect(shown()).toEqual([]);
    expect(toasts.error).toHaveBeenCalledWith("Couldn't save the recording of iPhone 17.", {
      id: `simulator-recording:${PHONE.id}`,
    });
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("says nothing about a recording Zeros ended as it quit", () => {
    showRecordingEnd({ deviceId: PHONE.id, reason: "quit", capture: RECORDING });
    expect(toasts.info).not.toHaveBeenCalled();
    expect(toasts.error).not.toHaveBeenCalled();
  });
});

describe("capture thumbnails", () => {
  it.each([false, true])("preserves file delivery but revokes focus after newer input: %s", async (interrupted) => {
    let finish!: (file: SimulatorCaptureFile) => void;
    api.loadSimulatorCaptureFile.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const adding = addSimulatorCaptureToChat(SCREENSHOT, "chat-1");
    expect(api.loadSimulatorCaptureFile).toHaveBeenCalledWith("capture-1");
    if (interrupted) focus.version++;
    finish({ fileName: SCREENSHOT.fileName, mimeType: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
    await expect(adding).resolves.toBe(true);
    expect(delivery.deliverFilesToChat).toHaveBeenCalledTimes(1);
    const [chatId, sent, options] = delivery.deliverFilesToChat.mock.calls[0]!;
    expect(chatId).toBe("chat-1");
    expect(sent.files[0].name).toBe(SCREENSHOT.fileName);
    expect(options?.focus ?? true).toBe(!interrupted);
  });

  it("adds the saved file to the chat's composer and closes its thumbnail", async () => {
    captureThumbnails.show(SCREENSHOT);
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    api.loadSimulatorCaptureFile.mockResolvedValue({
      fileName: SCREENSHOT.fileName,
      mimeType: "image/png",
      bytes,
    });
    await expect(addSimulatorCaptureToChat(SCREENSHOT, "chat-1")).resolves.toBe(true);
    expect(api.loadSimulatorCaptureFile).toHaveBeenCalledWith("capture-1");
    expect(delivery.deliverFilesToChat).toHaveBeenCalledTimes(1);
    const [chatId, sent] = delivery.deliverFilesToChat.mock.calls[0]!;
    expect(chatId).toBe("chat-1");
    expect(sent.id).toBe("simulator-capture:capture-1");
    const [file] = sent.files as File[];
    expect(file).toBeInstanceOf(File);
    expect(file).toMatchObject({ name: SCREENSHOT.fileName, type: "image/png", size: 4 });
    expect(new Uint8Array(await file!.arrayBuffer())).toEqual(bytes);
    expect(shown()).toEqual([]);
    expect(toasts.error).not.toHaveBeenCalled();
  });

  it("keeps the thumbnail when there is no chat or the file can't be added", async () => {
    captureThumbnails.show(RECORDING);
    await expect(addSimulatorCaptureToChat(RECORDING, null)).resolves.toBe(false);
    expect(toasts.error).toHaveBeenLastCalledWith("No chat to add this to.", {
      description: "Open or create a chat first.",
    });
    expect(api.loadSimulatorCaptureFile).not.toHaveBeenCalled();

    api.loadSimulatorCaptureFile.mockRejectedValueOnce(
      new Error("That recording is too large to add to a chat. It's in Downloads."),
    );
    await expect(addSimulatorCaptureToChat(RECORDING, "chat-1")).resolves.toBe(false);
    expect(toasts.error).toHaveBeenLastCalledWith(
      "That recording is too large to add to a chat. It's in Downloads.",
      { id: "simulator-capture:capture-2" },
    );

    api.loadSimulatorCaptureFile.mockResolvedValueOnce({
      fileName: "capture.dmg",
      mimeType: "video/mp4",
      bytes: new Uint8Array([1]),
    });
    await expect(addSimulatorCaptureToChat(RECORDING, "chat-1")).resolves.toBe(false);
    expect(toasts.error).toHaveBeenLastCalledWith(`Couldn't add "capture.dmg" to the chat.`, {
      id: "simulator-capture:capture-2",
      description: "Archives, installers, disk images, and compiled executables aren't supported",
    });
    expect(delivery.deliverFilesToChat).not.toHaveBeenCalled();
    expect(shown()).toEqual(["capture-2"]);
  });

  it("drags the saved file, and says so when it can't", async () => {
    dragSimulatorCaptureFile(SCREENSHOT);
    expect(api.dragSimulatorCapture).toHaveBeenCalledWith("capture-1");

    api.dragSimulatorCapture.mockRejectedValueOnce(new Error("That capture is no longer available."));
    dragSimulatorCaptureFile(SCREENSHOT);
    await vi.waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith("That capture is no longer available.", {
        id: "simulator-capture:capture-1",
      }),
    );
  });
});
