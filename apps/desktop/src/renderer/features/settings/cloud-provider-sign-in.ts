import {
  cloudProviderAuthStatusSchema,
  type CloudProviderAuthStatus,
} from "@zeros/protocol/provider-auth";
import { nativeInvoke } from "../../platform/runtime";

/** Only the active dialog observes a native ceremony. Closing it cancels the
 * native process; no credentials or native file paths enter renderer state. */
export async function connectCloudProviderSignIn(
  input: {
    organizationId: string;
    provider: "codex" | "cursor";
    displayName: string;
  },
  signal: AbortSignal,
  publish: (status: CloudProviderAuthStatus) => void,
) {
  const attemptId = crypto.randomUUID();
  const cancel = () => {
    void nativeInvoke("cloud_provider_auth", {
      action: "cancel",
      attemptId,
    }).catch(() => {});
  };
  const accept = (raw: unknown) => {
    const status = cloudProviderAuthStatusSchema.parse(raw);
    if (
      status.attemptId !== attemptId ||
      status.organizationId !== input.organizationId ||
      status.provider !== input.provider
    )
      throw new Error("Cloud sign-in changed. Try again.");
    return status;
  };
  signal.throwIfAborted();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    let status = accept(
      await nativeInvoke("cloud_provider_auth", {
        ...input,
        action: "connect",
        attemptId,
      }),
    );
    const deadline = Date.now() + 5 * 60_000;
    while (true) {
      signal.throwIfAborted();
      publish(status);
      if (status.state === "connected" && status.credential)
        return status.credential;
      if (status.state !== "connecting")
        throw new Error(status.error ?? "Sign-in canceled.");
      if (Date.now() >= deadline)
        throw new Error("Sign-in timed out. Try again.");
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Canceled", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 750);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      signal.throwIfAborted();
      status = accept(
        await nativeInvoke("cloud_provider_auth", {
          action: "status",
          attemptId,
        }),
      );
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
  }
}
