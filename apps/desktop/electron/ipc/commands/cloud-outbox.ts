// ──────────────────────────────────────────────────────────
// cloud-outbox IPC — renderer-reachable entry points for the durable cloud
// command outbox (S3-Q5). The outbox lives in Electron main, keyed by the
// main-owned auth session; the renderer never supplies an account identity.
// ──────────────────────────────────────────────────────────

import { app } from "electron";
import path from "node:path";
import { z } from "zod";
import { CloudRestClient, CloudRestError } from "@zeros/cloud-client";
import {
  CloudOutbox,
  createCloudOutboxIfEnabled,
  type CloudOutboxSender,
} from "../../cloud-outbox";
import { controlPlaneFetch } from "../../control-plane-fetch";
import { controlPlaneBaseUrl } from "../../workos-desktop-account";
import { cloudWorkspaceDesktopCapabilityEnabled } from "../../../src/engine/cloud-workspace-capability";
import type { CommandHandler } from "../router";
import {
  getSessionUserForMain,
  getValidAccessTokenForMain,
  onMainAuthSessionChanged,
} from "./auth-session";

const EnqueueSchema = z
  .object({
    operation: z.enum(["create", "wake", "stop", "archive", "delete", "rename"]),
    organizationId: z.string().min(1).max(255),
    workspaceId: z.string().min(1).max(255).optional(),
    body: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

type Active = { accountId: string; outbox: CloudOutbox };

let current: Active | null = null;
let installed = false;
let senderOverride: CloudOutboxSender | null = null;
let scheduleOverride: ((delayMs: number, run: () => void) => void) | null = null;

/** Test seam: the production sender is the S3 REST client below. */
export function __setCloudOutboxSenderForTests(
  send: CloudOutboxSender | null,
  schedule?: (delayMs: number, run: () => void) => void,
): void {
  senderOverride = send;
  scheduleOverride = schedule ?? null;
  current?.outbox.close();
  current = null;
}

/** The production sender: the typed S3 client, main-owned bearer token. */
function restSender(): CloudOutboxSender {
  const client = new CloudRestClient({
    baseUrl: controlPlaneBaseUrl(),
    getAccessToken: async () => {
      const token = await getValidAccessTokenForMain();
      if (!token) throw new Error("The cloud outbox requires a signed-in account.");
      return token;
    },
    fetchImpl: controlPlaneFetch as typeof fetch,
  });
  return async (entry) => {
    const options = { idempotencyKey: entry.id };
    try {
      const response =
        entry.operation === "create"
          ? await client.create(entry.organizationId, entry.body ?? {}, options)
          : entry.operation === "rename"
            ? await client.rename(entry.organizationId, entry.workspaceId!, String(entry.body?.name), options)
            : await client.lifecycle(entry.organizationId, entry.workspaceId!, entry.operation, options);
      return { status: response.status, replayed: response.replayed, body: response.body };
    } catch (error) {
      // Translate the SDK error into the plain failure shape the outbox
      // classifies (network / status / retryable body).
      if (error instanceof CloudRestError)
        throw Object.assign(new Error(error.message), {
          status: error.status === 0 ? undefined : error.status,
          code: error.code,
          networkError: error.code === "network_error",
          body: {
            error: {
              code: error.code,
              retryable: error.retryable,
              ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
            },
          },
        });
      throw error;
    }
  };
}

function sessionAccountId(): string {
  const user = getSessionUserForMain();
  const accountId = user?.accountId ?? user?.sub ?? null;
  if (!user || !accountId) throw new Error("The cloud outbox requires a signed-in account.");
  return accountId;
}

function activeOutbox(): Active {
  const accountId = sessionAccountId();
  if (current?.accountId === accountId) return current;
  const opened = createCloudOutboxIfEnabled({
    capabilityEnabled: cloudWorkspaceDesktopCapabilityEnabled,
    open: () =>
      new CloudOutbox({
        accountId,
        directory: path.join(app.getPath("userData"), "cloud-outbox-v1"),
        send: senderOverride ?? restSender(),
        ...(scheduleOverride !== null ? { schedule: scheduleOverride } : {}),
      }),
  });
  if (!opened)
    throw new Error("Cloud workspaces are disabled on this desktop build.");
  current?.outbox.close();
  current = { accountId, outbox: opened };
  return current;
}

/** Sign-out (and switching away) clears that account's outbox (S3-Q5). */
export function installCloudOutboxLifecycle(): void {
  if (installed) return;
  installed = true;
  onMainAuthSessionChanged(() => {
    const previous = current;
    current = null;
    if (!previous) return;
    try {
      let nextAccount: string | null = null;
      try {
        nextAccount = getSessionUserForMain()?.accountId ?? getSessionUserForMain()?.sub ?? null;
      } catch {
        nextAccount = null;
      }
      if (previous.accountId !== nextAccount) previous.outbox.clear();
    } catch {
      // Outbox cleanup must never block sign-out.
    } finally {
      previous.outbox.close();
    }
  });
}

export const cloudWorkspaceOutboxEnqueue: CommandHandler = (args) => {
  const input = EnqueueSchema.parse(args);
  if (input.operation !== "create" && !input.workspaceId)
    throw new Error("cloud outbox: workspaceId is required.");
  if (input.operation === "rename") {
    const name = input.body?.name;
    if (typeof name !== "string" || !name.trim())
      throw new Error("cloud outbox: rename needs a non-empty body.name.");
  }
  const { outbox } = activeOutbox();
  const entry = outbox.enqueue(input);
  void outbox.drain();
  return entry;
};

export const cloudWorkspaceOutboxList: CommandHandler = () => {
  return activeOutbox().outbox.list();
};
