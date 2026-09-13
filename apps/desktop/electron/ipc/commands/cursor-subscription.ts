import { shell } from "electron";
import { cursorSubscriptionActionSchema } from "@zeros/protocol/provider-auth";
import { CursorSubscriptionController } from "../../cursor-subscription-controller";
import {
  readLegacyCursorSubscription,
  writeCursorSubscription,
} from "../../provider-credentials";
import { pushProviderCredentialsToEngine } from "../../sidecar";
import type { CommandHandler } from "../router";

export const loginCursorSubscription = async (signal: AbortSignal) => {
    const { Cursor } = await import("@cursor/sdk");
    if (signal.aborted) throw new Error("Canceled");
    return Cursor.auth.login({
      signal,
      store: null,
      apiKeyName: "Zeros",
      backendUrl: "https://api2.cursor.sh",
      websiteUrl: "https://cursor.com",
      onLoginUrl: () => {}, // Never print authorization URLs to stderr.
      openBrowser: async (raw) => {
        const url = new URL(raw);
        if (
          url.origin !== "https://cursor.com" ||
          url.username ||
          url.password ||
          signal.aborted
        )
          throw new Error("Invalid Cursor sign-in destination");
        await shell.openExternal(url.href);
      },
    });
};
export const cursorSubscriptionController = new CursorSubscriptionController({
  read: readLegacyCursorSubscription,
  write: writeCursorSubscription,
  publish: () => { void pushProviderCredentialsToEngine().catch(() => {}); },
  login: loginCursorSubscription,
});

export const cursorSubscription: CommandHandler = (args) => {
  const { action } = cursorSubscriptionActionSchema.parse(args);
  switch (action) {
    case "status":
      return cursorSubscriptionController.status();
    case "connect":
      return cursorSubscriptionController.connect();
    case "cancel":
      return cursorSubscriptionController.cancel();
    case "disconnect":
      return cursorSubscriptionController.disconnect();
  }
};
