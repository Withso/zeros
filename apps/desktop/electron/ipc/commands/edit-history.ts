import { webContents } from "electron";
import { getMainWindow } from "../events";
import type { CommandHandler } from "../router";

/** Native text history only, after the app's focused feature declines it. */
export const editHistory: CommandHandler = (args, event) => {
  const contents = getMainWindow()?.webContents;
  if (!contents || event.sender !== contents || !event.senderFrame ||
    event.senderFrame !== contents.mainFrame)
    throw new Error("Edit history requires the app's main frame.");
  if (!args || Array.isArray(args) || Object.keys(args).length !== 1 ||
    (args.direction !== "undo" && args.direction !== "redo"))
    throw new Error("Edit history requires an undo or redo direction.");
  // A focus change between the menu event and this reply must not edit the
  // newly focused window, or a text field in the now-inactive app.
  if (contents.isDestroyed() || webContents.getFocusedWebContents() !== contents) return;
  contents[args.direction]();
};
