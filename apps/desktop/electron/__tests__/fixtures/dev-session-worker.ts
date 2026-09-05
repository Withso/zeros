import {
  getValidSessionForMain,
  getSessionUserForMain,
  persistWorkOSSession,
} from "../../ipc/commands/auth-session";
import {
  getSecret,
  replaceSecretIfUnchanged,
  watchSecrets,
} from "../../secret-store";
import { WorkOSDevCallbackRelay } from "../../workos-dev-callback-relay";

const relay = new WorkOSDevCallbackRelay();
watchSecrets((keys) => {
  if (keys.includes("auth-session:tokens"))
    process.send?.({
      event: "session-changed",
      user: getSessionUserForMain()?.accountId ?? null,
    });
});
process.on(
  "message",
  async (message: { id: number; command: string; value: any }) => {
    try {
      let result: unknown;
      switch (message.command) {
        case "install":
          persistWorkOSSession(message.value);
          result = true;
          break;
        case "read":
          result = await getValidSessionForMain();
          break;
        case "expire": {
          const raw = getSecret("auth-session:tokens")!;
          result = replaceSecretIfUnchanged(
            "auth-session:tokens",
            raw,
            JSON.stringify({ ...JSON.parse(raw), expiresAt: 1 }),
          );
          break;
        }
        case "begin":
          relay.register(
            message.value.state,
            Date.now() + 60_000,
            (callback) => {
              process.send?.({ event: "callback", code: callback.code });
              return true;
            },
          );
          result = true;
          break;
        case "deliver":
          result = relay.deliver(message.value);
          break;
        default:
          throw new Error("unknown fixture command");
      }
      process.send?.({ id: message.id, result });
    } catch (error) {
      process.send?.({
        id: message.id,
        error: error instanceof Error ? error.message : "fixture failed",
      });
    }
  },
);
process.send?.({ event: "ready" });
