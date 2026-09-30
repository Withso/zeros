import { app, shell } from "electron";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import path from "node:path";
import {
  cloudProviderAuthActionSchema,
  cloudProviderCredentialMetadataSchema,
} from "@zeros/protocol/provider-auth";
import { CloudProviderAuthController } from "../../cloud-provider-auth-controller";
import { createSubscriptionDriver } from "../../provider-subscription-drivers";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";
import {
  getValidSessionForMain,
  onMainAuthSessionChanged,
} from "./auth-session";
import { loginCursorSubscription } from "./cursor-subscription";
import { resolveRuntime } from "./provider-subscription";
import type { CommandHandler } from "../router";

const controller = new CloudProviderAuthController({
  reportFailure(event) { console.warn("[cloud-provider-auth] connection failed", event); },
  session: getValidSessionForMain,
  async login(provider, signal, onDeviceCode) {
    if (provider === "cursor") {
      const result = await loginCursorSubscription(signal);
      if (
        !result.apiKey ||
        !Number.isFinite(result.apiKeyExpiresAtMs) ||
        result.apiKeyExpiresAtMs <= Date.now()
      )
        throw new Error("Sign-in failed");
      return {
        apiKey: result.apiKey,
        expiresAt: Math.floor(result.apiKeyExpiresAtMs / 1000),
      };
    }
    const parent = path.join(app.getPath("userData"), "cloud-provider-auth");
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const profile = await mkdtemp(path.join(parent, "codex-"));
    try {
      const driver = createSubscriptionDriver("codex", {
        resolveRuntime: async () => ({
          ...(await resolveRuntime("codex", profile, true)),
          argsPrefix: ["-c", 'cli_auth_credentials_store="file"'],
        }),
        openBrowser: (url) => shell.openExternal(url),
        onDeviceCode,
      });
      const account = await driver.login({ signal, onCodeRequired: () => {} });
      signal.throwIfAborted();
      if (account.state !== "connected") throw new Error("Sign-in failed");
      const file = await open(
        path.join(profile, "auth.json"),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 64 * 1024)
          throw new Error("Invalid native account cache");
        const buffer = await file.readFile();
        try {
          return {
            nativeCache: JSON.parse(buffer.toString("utf8")) as unknown,
          };
        } finally {
          buffer.fill(0);
        }
      } finally {
        await file.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
  async save(input, session, material, signal) {
    const native = "nativeCache" in material;
    const body = {
      organizationId: input.organizationId,
      operationId: input.attemptId,
      expectedRevision: 0,
      displayName: input.displayName,
      ...(native
        ? { nativeCache: material.nativeCache }
        : {
            material: {
              kind: "cursor-api-key",
              apiKey: material.apiKey,
              expiresAt: material.expiresAt,
            },
          }),
    };
    const response = await fetch(
      `${controlPlaneBaseUrl()}/v1/cloud-agent-credentials/${input.attemptId}${native ? "/native-codex" : ""}`,
      {
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: {
          authorization: `Bearer ${session.accessToken}`,
          "content-type": "application/json",
          "Idempotency-Key": input.attemptId,
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cloud account import failed");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty cloud response");
    let text = "",
      size = 0;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8192) {
          await reader.cancel();
          throw new Error("Invalid cloud response");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } finally {
      reader.releaseLock();
    }
    const result = JSON.parse(text + decoder.decode()) as {
      credential?: unknown;
    };
    return cloudProviderCredentialMetadataSchema.parse(result.credential);
  },
});

onMainAuthSessionChanged(() => controller.stop());
const windows = new Set<number>();
export const cloudProviderAuth: CommandHandler = (args, event) => {
  if (!cloudWorkspaceDesktopCapabilityEnabled())
    throw new Error("Cloud accounts are unavailable in this build.");
  const request = cloudProviderAuthActionSchema.safeParse(args);
  if (!request.success)
    throw new Error("Invalid cloud account connection request.");
  const id = event.sender.id;
  if (!windows.has(id)) {
    windows.add(id);
    event.sender.once("destroyed", () => {
      windows.delete(id);
      void controller.cancelWindow(id);
    });
  }
  return controller.request(request.data, id);
};
export const stopCloudProviderAuth = () => controller.stop();
