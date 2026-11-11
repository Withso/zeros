import { z } from "zod";
import { CloudV2PromptCounterSchema, CloudV2PromptIdSchema, CloudV2PromptReceiptSchema, CloudV2PromptStatusSchema,
  CloudV2PromptStopReplySchema, type CloudV2Prompt, type CloudV2PromptReceipt } from "@zeros/protocol/cloud-v2-prompts";
import { cloudAccountRequest } from "./cloud-workspaces";
import { sharingFor } from "./team-sharing-registry";
import { localCommandDevice } from "./local-commands";
import type { CloudWorkspaceTarget } from "./bridge/cloud-workspace-key";

export function cloudPromptApi(target: CloudWorkspaceTarget, chatId: string) {
  const path = `/v1/cloud-v2/workspaces/${z.string().uuid().parse(target.workspaceId)}/prompts`;
  CloudV2PromptIdSchema.parse(chatId);
  const check = (receipt: CloudV2PromptReceipt) => {
    if (receipt.workspaceId !== target.workspaceId || receipt.chatId !== chatId) throw new Error("Cloud receipt changed conversation identity.");
    return receipt;
  };
  return {
    async enqueue(payload: CloudV2Prompt) {
      if (payload.chatId !== chatId) throw new Error("This message belongs to another conversation.");
      // A message from this Mac makes it the chat's local-command target.
      const device = await localCommandDevice();
      const { receipt } = await cloudAccountRequest(path, z.object({ receipt: CloudV2PromptReceiptSchema }),
        { body: payload, idempotencyKey: payload.userMessageId }, { ...sharingFor(target.workspaceId), ...(device ? { deviceHeaders: device.headers } : {}) });
      if (receipt.userMessageId !== payload.userMessageId) throw new Error("Cloud receipt changed message identity.");
      return check(receipt);
    },
    async list(after: string, includePayload: boolean) {
      const query = new URLSearchParams({ chatId, after: CloudV2PromptCounterSchema.parse(after), includePayload: String(includePayload) });
      const page = await cloudAccountRequest(`${path}?${query}`, z.object({ epoch: CloudV2PromptCounterSchema,
        items: z.array(CloudV2PromptStatusSchema).max(100), nextAfter: CloudV2PromptCounterSchema.nullable() }), undefined, { ...sharingFor(target.workspaceId), promptRecovery: true });
      for (const row of page.items) check(row.receipt);
      return page;
    },
    async stop(throughEpoch: string) {
      const reply = await cloudAccountRequest(`${path}/stop`, CloudV2PromptStopReplySchema,
        { body: { chatId, throughEpoch }, idempotencyKey: `stop:${chatId}:${throughEpoch}` }, sharingFor(target.workspaceId));
      if (reply.chatId !== chatId) throw new Error("Cloud Stop changed conversation identity.");
      return reply;
    },
  };
}
