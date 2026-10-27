import type { WebContents } from "electron";
import { DesignCaptureAdmission } from "../src/engine/design/capture-admission";
import type { CommandHandler } from "./ipc/router";

export const electronDesignCaptureAdmission = new DesignCaptureAdmission();
const watched = new WeakSet<WebContents>();

function jobId(args: Record<string, unknown>): string {
  if (typeof args.jobId !== "string" || !/^[a-f0-9-]{36}$/.test(args.jobId))
    throw new Error("Invalid Design capture reservation.");
  return args.jobId;
}

export const designCaptureAcquire: CommandHandler = (args, event) => {
  const id = jobId(args);
  if (event.senderFrame !== event.sender.mainFrame || event.sender.isDestroyed() || typeof args.explicit !== "boolean")
    throw new Error("Invalid Design capture owner.");
  const acquired = electronDesignCaptureAdmission.reserve(event.sender, id, args.explicit);
  if (acquired && !watched.has(event.sender)) {
    watched.add(event.sender);
    // Navigation, disconnect and a timeout are not cleanup acknowledgements.
    // Destroying the owning WebContents disposes all its authored documents.
    event.sender.once("destroyed", () => electronDesignCaptureAdmission.retireOwner(event.sender));
  }
  return { acquired };
};

export const designCaptureRelease: CommandHandler = (args, event) => {
  const id = jobId(args);
  if (event.senderFrame !== event.sender.mainFrame)
    throw new Error("Invalid Design capture owner.");
  return { released: electronDesignCaptureAdmission.release(event.sender, id) };
};
