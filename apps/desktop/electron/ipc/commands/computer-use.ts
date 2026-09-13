import type { CommandHandler } from "../router";
import { nativeAppIconByBundleId } from "./open-apps";
import { fetchToolArtwork } from "../../tool-artwork";
import { safeToolImageSource } from "@zeros/protocol/tool-artwork";

/** Native IDs only, batched and bounded. No generic file or app-launch IPC. */
export const nativeAppIcons: CommandHandler = async (args) => {
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
    throw new Error("Invalid application icon request.");
  const ids = [...new Set(args.bundleIds as string[])];
  const entries: Record<string, string | null> = {};
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      for (;;) {
        const id = ids.shift();
        if (!id) return;
        entries[id] = await nativeAppIconByBundleId(id).catch(() => null);
      }
    }),
  );
  return entries;
};

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
