import { validateAttachmentFile } from "@zeros/protocol/attachment-policy";
import type { SimulatorCapture, SimulatorRecordingEnd } from "@zeros/protocol/simulator-captures";
import type { SimulatorDevice } from "@zeros/protocol/simulators";

import { deliverFilesToChat } from "../agent/composer-file-attachment-delivery";
import { toast } from "../../shared/ui/primitives/elements";
import {
  dragSimulatorCapture,
  loadSimulatorCaptureFile,
  startSimulatorRecording,
  stopSimulatorRecording,
  takeSimulatorScreenshot,
} from "./simulator-api";
import { captureThumbnails, flashSimulatorScreen } from "./simulator-capture-store";
import { simulatorErrorMessage, simulatorRecordingEndNotice } from "./simulator-notices";

// What the island's capture buttons and the capture thumbnails do. Outcomes
// are toasts, as for every other action in the app; a saved capture shows as
// a thumbnail.

type Device = Pick<SimulatorDevice, "id" | "name">;

/** Screenshot: the screen flashes as it is taken, and the saved file shows
 * as a thumbnail. */
export async function takeScreenshotFromTab(device: Device): Promise<boolean> {
  flashSimulatorScreen(device.id);
  try {
    captureThumbnails.show(await takeSimulatorScreenshot(device.id));
    return true;
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't take a screenshot of ${device.name}.`), {
      id: `simulator-screenshot:${device.id}`,
    });
    return false;
  }
}

export async function startRecordingFromTab(device: Device): Promise<boolean> {
  try {
    await startSimulatorRecording(device.id);
    return true;
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't start recording ${device.name}.`), {
      id: `simulator-recording:${device.id}`,
    });
    return false;
  }
}

/** Stop: the video is saved to Downloads and shows as a thumbnail. */
export async function stopRecordingFromTab(device: Device): Promise<boolean> {
  try {
    captureThumbnails.show(await stopSimulatorRecording(device.id));
    return true;
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't save the recording of ${device.name}.`), {
      id: `simulator-recording:${device.id}`,
    });
    return false;
  }
}

/** A recording that ended without Stop still shows as a thumbnail, with a
 * toast saying why it ended. */
export function showRecordingEnd(end: SimulatorRecordingEnd): void {
  if ("capture" in end) captureThumbnails.show(end.capture);
  const notice = simulatorRecordingEndNotice(end);
  if (!notice) return;
  const options = {
    id: `simulator-recording:${end.deviceId}`,
    ...(notice.description ? { description: notice.description } : {}),
  };
  if (notice.tone === "error") toast.error(notice.title, options);
  else toast.info(notice.title, options);
}

/** Add to chat: the capture's file goes into the chat's composer, as if the
 * user had dropped it there. */
export async function addSimulatorCaptureToChat(
  capture: SimulatorCapture,
  chatId: string | null,
): Promise<boolean> {
  if (!chatId) {
    toast.error("No chat to add this to.", { description: "Open or create a chat first." });
    return false;
  }
  let file: File;
  try {
    const loaded = await loadSimulatorCaptureFile(capture.id);
    file = new File([loaded.bytes as BlobPart], loaded.fileName, { type: loaded.mimeType });
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't add "${capture.fileName}" to the chat.`), {
      id: `simulator-capture:${capture.id}`,
    });
    return false;
  }
  const validation = validateAttachmentFile({
    name: file.name,
    mimeType: file.type,
    size: file.size,
  });
  if (!validation.ok) {
    toast.error(`Couldn't add "${file.name}" to the chat.`, {
      id: `simulator-capture:${capture.id}`,
      description: validation.reason,
    });
    return false;
  }
  deliverFilesToChat(chatId, { id: `simulator-capture:${capture.id}`, files: [file] });
  captureThumbnails.dismiss(capture.id);
  return true;
}

/** A thumbnail's drag carries the saved file itself, so it drops into the
 * composer or Finder alike. */
export function dragSimulatorCaptureFile(capture: SimulatorCapture): void {
  void dragSimulatorCapture(capture.id).catch((error: unknown) => {
    toast.error(simulatorErrorMessage(error, `Couldn't drag "${capture.fileName}".`), {
      id: `simulator-capture:${capture.id}`,
    });
  });
}
