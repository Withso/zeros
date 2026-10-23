import { describe, expect, it } from "vitest";
import { canSwitchPristineChat } from "../pristine-chat";
import { BLANK } from "../sessions-store";
import { providerBindingForResume } from "@zeros/protocol/identities";

const cloud = "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222";
const chat = (folder = cloud, title = "Untitled") => ({ folder, title });

describe("pristine chat identity", () => {
  it("accepts both cloud untitled representations, with a warm execution but no native binding", () => {
    const slot = { ...BLANK, status: "ready" as const, sessionId: "warm-execution" };
    for (const title of ["", "Untitled"]) expect(canSwitchPristineChat(chat(cloud, title), slot)).toBe(true);
  });
  it.each(["/personal/project", "/organization/project"])("preserves the Local predicate in %s", folder => {
    expect(canSwitchPristineChat(chat(folder), BLANK)).toBe(true);
    expect(canSwitchPristineChat(chat(folder, ""), BLANK)).toBe(false);
    expect(canSwitchPristineChat({ ...chat(folder), sessionId: "local-native" }, BLANK)).toBe(true);
    expect(canSwitchPristineChat(chat(folder), { ...BLANK, hasTranscript: true })).toBe(false);
  });
  it.each([
    { transcriptState: "loading" as const }, { transcriptState: "cold" as const }, { hasTranscript: true },
    { providerBinding: providerBindingForResume("codex", "native") }, { foregroundTurnId: "first-send" },
    { activeTurnStartedAt: 0 }, { cloudPromptPending: true },
    { cloudOutbox: { rows: [{ id: "saved", kind: "text" as const, role: "user" as const, text: "ok", createdAt: 1 }], states: {}, pendingCount: 1, waiting: false } },
    { messages: [{ id: "sent", kind: "text" as const, role: "user" as const, text: "ok", createdAt: 1 }] },
  ])("refuses non-pristine cloud evidence %j", patch => {
    expect(canSwitchPristineChat(chat(), { ...BLANK, ...patch })).toBe(false);
  });
  it("honors durable bindings even when the transcript was evicted", () => {
    expect(canSwitchPristineChat({ ...chat(), providerBinding: providerBindingForResume("codex", "native") }, BLANK)).toBe(false);
    expect(canSwitchPristineChat({ ...chat(), sessionId: "native" }, BLANK)).toBe(false);
    expect(canSwitchPristineChat(chat(cloud, "A real conversation"), BLANK)).toBe(false);
  });
});
