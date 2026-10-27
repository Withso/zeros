import { afterEach, expect, it } from "vitest";
import { setActiveBridge } from "../../../platform/bridge/active-bridge";
import type { RuntimeClient } from "../../../platform/bridge/ws-client";
import { listChatSummariesForFolder } from "../agent-history-client";

afterEach(() => setActiveBridge(null));

it.each(["CLOUD_V2_UNAVAILABLE", "CLOUD_V2_STOPPED"])("keeps %s distinct from a confirmed empty summary list", async code => {
  setActiveBridge({ request: async () => ({ type: "WORKSPACE_ERROR", op: "chats.summariesForFolder", code, message: "Summary read unavailable" }) } as unknown as RuntimeClient);
  await expect(listChatSummariesForFolder({ folder: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222" }))
    .rejects.toThrow("Summary read unavailable");
});
