import { describe, expect, it } from "vitest";
import { cloudScopedId, cloudWorkspaceKey } from "../../../platform/bridge/cloud-workspace-key";
import { consumeFreshCloudChat, forgetFreshCloudChat, markFreshCloudChat } from "../fresh-cloud-chats";

const a = { organizationId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const b = { ...a, organizationId: "33333333-3333-4333-8333-333333333333" };
describe("renderer-created cloud chat facts", () => {
  it("requires the exact scoped owner and consumes the fact once", () => {
    const chat = cloudScopedId(a, "new-chat");
    markFreshCloudChat(chat, cloudWorkspaceKey(a));
    expect(consumeFreshCloudChat(chat, cloudWorkspaceKey(b))).toBe(false);
    expect(consumeFreshCloudChat(cloudScopedId(b, "new-chat"), cloudWorkspaceKey(b))).toBe(false);
    expect(consumeFreshCloudChat(chat, cloudWorkspaceKey(a))).toBe(true);
    expect(consumeFreshCloudChat(chat, cloudWorkspaceKey(a))).toBe(false);
  });
  it("cannot mark a Local, foreign-workspace or deleted chat empty", () => {
    markFreshCloudChat("local-chat", "/personal/project");
    expect(consumeFreshCloudChat("local-chat", "/personal/project")).toBe(false);
    const chat = cloudScopedId(a, "foreign");
    markFreshCloudChat(chat, cloudWorkspaceKey(b));
    expect(consumeFreshCloudChat(chat, cloudWorkspaceKey(b))).toBe(false);
    markFreshCloudChat(chat, cloudWorkspaceKey(a)); forgetFreshCloudChat(chat);
    expect(consumeFreshCloudChat(chat, cloudWorkspaceKey(a))).toBe(false);
  });
  it("bounds unused facts and evicts only the oldest", () => {
    for (let i = 0; i < 65; i++) markFreshCloudChat(cloudScopedId(a, `bounded-${i}`), cloudWorkspaceKey(a));
    expect(consumeFreshCloudChat(cloudScopedId(a, "bounded-0"), cloudWorkspaceKey(a))).toBe(false);
    for (let i = 1; i < 65; i++) expect(consumeFreshCloudChat(cloudScopedId(a, `bounded-${i}`), cloudWorkspaceKey(a))).toBe(true);
  });
});
