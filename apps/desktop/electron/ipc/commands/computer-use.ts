import type { OpenDialogOptions, OpenDialogReturnValue } from "electron";
import { isComputerBundleId } from "@zeros/protocol/computer-use-tools";

import type { CommandHandler } from "../router";
import {
  appBundleIdentity,
  nativeAppIconByBundleId,
  nativeAppNameByBundleId,
} from "./open-apps";
import { fetchToolArtwork } from "../../tool-artwork";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";

function readBundleIds(args: Record<string, unknown>, request: string): string[] {
  if (
    !Array.isArray(args.bundleIds) ||
    args.bundleIds.length > 16 ||
    args.bundleIds.some(
      (id) =>
        typeof id !== "string" ||
        id.length > 255 ||
        !/^[\w-]+(?:\.[\w-]+)+$/.test(id),
    )
  )
    throw new Error(`Invalid application ${request} request.`);
  return [...new Set(args.bundleIds as string[])];
}

async function byBundleId(
  ids: string[],
  read: (bundleId: string) => Promise<string | null>,
): Promise<Record<string, string | null>> {
  const entries: Record<string, string | null> = {};
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const id = ids.shift();
        if (!id) return;
        entries[id] = await read(id).catch(() => null);
      }
    }),
  );
  return entries;
}

/** Native IDs only, batched and bounded. No generic file or app-launch IPC. */
export const nativeAppIcons: CommandHandler = async (args) =>
  byBundleId(readBundleIds(args, "icon"), nativeAppIconByBundleId);

/** Names for bundle IDs in Settings, such as the blocked-apps list. */
export const nativeAppNames: CommandHandler = async (args) =>
  byBundleId(readBundleIds(args, "name"), nativeAppNameByBundleId);

export interface ChosenComputerApp {
  bundleId: string;
  name: string;
}

/** Settings > Computer use > Blocked apps > Add app. The user picks the app in
 * the macOS open panel and only its bundle ID and name come back. */
export async function chooseComputerApp(
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
): Promise<ChosenComputerApp | null> {
  const result = await showOpenDialog({
    title: "Block an app",
    buttonLabel: "Block",
    defaultPath: "/Applications",
    properties: ["openFile"],
    filters: [{ name: "Applications", extensions: ["app"] }],
  });
  const appPath = result.filePaths[0];
  if (result.canceled || result.filePaths.length !== 1 || !appPath) return null;
  const identity = await appBundleIdentity(appPath);
  if (!identity || !isComputerBundleId(identity.bundleId)) {
    throw new Error("That app has no bundle identifier.");
  }
  return { bundleId: identity.bundleId, name: identity.name.slice(0, 200) };
}

export const toolArtworkImages: CommandHandler = async (args) => {
  if (
    !Array.isArray(args.urls) ||
    args.urls.length > 16 ||
    args.urls.some((url) => !safeToolImageSource(url)?.startsWith("https:"))
  )
    throw new Error("Invalid tool artwork request.");
  const urls = [...new Set(args.urls as string[])];
  const result: Record<string, string | null> = {};
  await Promise.all(
    Array.from({ length: Math.min(4, urls.length) }, async () => {
      for (;;) {
        const url = urls.shift();
        if (!url) return;
        result[url] = await fetchToolArtwork(url);
      }
    }),
  );
  return result;
};
