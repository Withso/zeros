import { afterEach, describe, expect, it, vi } from "vitest";
import {
  liveEditDraftEntries,
  pruneLiveEditDrafts,
  registerLiveEditDraft,
  subscribeToLiveEditDrafts,
} from "../edit-live-drafts";

const draft = { text: "edited text", newAttachments: [], keptOriginals: [] };
afterEach(() => pruneLiveEditDrafts(new Set()));

describe("mounted edit draft ownership", () => {
  it("prevents a replaced editor from publishing or clearing the replacement", () => {
    const old = registerLiveEditDraft("chat:message", "chat", draft);
    const current = registerLiveEditDraft("chat:message", "chat", {
      ...draft,
      text: "new edit",
    });
    old.update(null);
    old.dispose();
    expect(old.isCurrent()).toBe(false);
    expect([...liveEditDraftEntries()]).toEqual([
      [
        "chat:message",
        { chatId: "chat", draft: { ...draft, text: "new edit" } },
      ],
    ]);
    current.dispose();
    expect([...liveEditDraftEntries()]).toEqual([]);
  });
  it("prunes deleted owners and rejects their later editor updates", () => {
    const removed = registerLiveEditDraft("removed:message", "removed", draft);
    registerLiveEditDraft("kept:message", "kept", draft);
    pruneLiveEditDrafts(new Set(["kept"]));
    removed.update(draft);
    expect([...liveEditDraftEntries()].map(([key]) => key)).toEqual([
      "kept:message",
    ]);
  });
  it("notifies persistence when typing and clearing without a global store write", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToLiveEditDrafts(listener);
    const owner = registerLiveEditDraft("chat:message", "chat", null);
    owner.update(draft);
    owner.update(null);
    owner.dispose();
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });
});
