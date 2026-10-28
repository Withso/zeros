import { validateAttachmentFile } from "@zeros/protocol/attachment-policy";
import type { SimulatorDevice } from "@zeros/protocol/simulators";

import { deliverFilesToChat } from "../agent/composer-file-attachment-delivery";
import { useWorkspaceStore } from "../../state/workspace-store";
import { toast } from "../../shared/ui/primitives/elements";
import { getFocusInteractionVersion } from "../../shared/ui/focus-navigation";
import { annotationFileNames, annotationMarksText } from "./simulator-annotation-model";
import { readAnnotationPalette, renderAnnotatedScreen } from "./simulator-annotation-painter";
import { openSimulatorTabIds, simulatorAnnotations } from "./simulator-annotation-store";
import { simulatorErrorMessage } from "./simulator-notices";

// What Annotate and its toolbar do. Outcomes are toasts, as for the other
// captures; the marks go to the chat as an image and a marks file, the way
// the Browser element picker sends what it picked.

/** Annotate: the tab freezes the device's screen to draw on. */
export async function annotateFromTab(
  tabId: string,
  device: Pick<SimulatorDevice, "id" | "name">,
): Promise<boolean> {
  try {
    return (await simulatorAnnotations.begin(tabId, device)) !== null;
  } catch (error) {
    toast.error(simulatorErrorMessage(error, `Couldn't capture ${device.name}'s screen.`), {
      id: `simulator-annotate:${device.id}`,
    });
    return false;
  }
}

/** Leaves the tab's annotation, asking first when that would discard marks.
 * `then` runs once the annotation has ended, and not if the user keeps it. */
export function leaveSimulatorAnnotation(tabId: string, then?: () => void): void {
  simulatorAnnotations.leave(tabId, then);
}

/** Add to chat: the annotated screen and its marks file go into the chat's
 * composer, as if the user had dropped them there. `themed` is where the
 * marks' colors are read, so the image matches what the user drew. */
export async function addAnnotationToChat(
  tabId: string,
  chatId: string | null,
  themed: HTMLElement,
): Promise<boolean> {
  const annotation = simulatorAnnotations.get(tabId);
  const snapshot = annotation?.snapshot;
  if (!annotation || !snapshot || annotation.adding) return false;
  if (!chatId) {
    toast.error("No chat to add this to.", { description: "Open or create a chat first." });
    return false;
  }
  const { serial, deviceName } = annotation;
  const focusVersion = getFocusInteractionVersion();
  const marks = annotation.history.marks;
  const toastId = `simulator-annotate:${annotation.deviceId}`;
  simulatorAnnotations.setAdding(tabId, serial, true);
  let files: File[];
  try {
    const names = annotationFileNames(deviceName, new Date(annotation.frozenAt));
    const image = await renderAnnotatedScreen(snapshot, marks, readAnnotationPalette(themed));
    files = [
      new File([image], names.image, { type: "image/png" }),
      new File([annotationMarksText({ imageName: names.image, snapshot, marks })], names.marks, {
        type: "text/plain",
      }),
    ];
  } catch (error) {
    simulatorAnnotations.setAdding(tabId, serial, false);
    toast.error(simulatorErrorMessage(error, "Couldn't add the annotations to the chat."), {
      id: toastId,
    });
    return false;
  }
  // The tab may have closed while the image was drawn.
  if (simulatorAnnotations.get(tabId)?.serial !== serial) return false;
  for (const file of files) {
    const validation = validateAttachmentFile({
      name: file.name,
      mimeType: file.type,
      size: file.size,
    });
    if (!validation.ok) {
      simulatorAnnotations.setAdding(tabId, serial, false);
      toast.error(`Couldn't add "${file.name}" to the chat.`, {
        id: toastId,
        description: validation.reason,
      });
      return false;
    }
  }
  deliverFilesToChat(chatId, { id: `simulator-annotation:${tabId}:${serial}`, files }, {
    focus: focusVersion === getFocusInteractionVersion(),
  });
  simulatorAnnotations.end(tabId);
  return true;
}

/** Ends each annotation as its tab closes, in any workspace, until the
 * returned function runs. */
export function followSimulatorAnnotationTabs(): () => void {
  return useWorkspaceStore.subscribe((state, previous) => {
    if (state.workbenchByScope === previous.workbenchByScope || !simulatorAnnotations.any()) {
      return;
    }
    simulatorAnnotations.prune(openSimulatorTabIds(state.workbenchByScope));
  });
}
