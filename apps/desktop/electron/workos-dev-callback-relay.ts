import { DevCallbackRelay, type RelayStore } from "./dev-callback-relay";
import type { WorkOSDesktopAuthorizationCallback } from "./workos-desktop-flow";

const STATE = /^zeros-dev\.[A-Za-z0-9_-]{43}$/;

/** The v1 WorkOS routing key/schema remains compatible with older Dev windows. */
export class WorkOSDevCallbackRelay extends DevCallbackRelay<WorkOSDesktopAuthorizationCallback> {
  constructor(store?: RelayStore, now?: () => number) {
    super({
      key: "auth-workos:dev-callbacks",
      validState: state => STATE.test(state),
      state: callback => callback.state,
      normalize(value) {
        const input = value as WorkOSDesktopAuthorizationCallback | null;
        if (!input || typeof input.state !== "string" || !STATE.test(input.state)) return null;
        if (typeof input.code === "string" && input.code.length > 0 && input.code.length <= 8192 && !input.error)
          return { state: input.state, code: input.code };
        if (!input.code && input.error === "provider_error") return { state: input.state, error: "provider_error" };
        return null;
      },
    }, store, now);
  }
}
