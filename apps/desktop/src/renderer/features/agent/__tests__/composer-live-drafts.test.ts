import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getLiveChatDraft,
  registerLiveChatDraftRestorer,
  setLiveChatDraft,
  tryRestoreLiveChatDraft,
} from "../composer-live-drafts";
import type { ComposerDraft } from "../../../state/store";

const restoredDraft: ComposerDraft = {
  text: "Please retry this message",
  attachments: [],
  json: null,
};

const newerDraft: ComposerDraft = {
  text: "Newer typing wins",
  attachments: [],
  json: null,
};

describe("live composer draft restoration", () => {
  afterEach(() => {
    setLiveChatDraft("chat-restore", null);
  });

  it("routes a failed queued send through the mounted composer owner", () => {
    const applied: ComposerDraft[] = [];
    const unregister = registerLiveChatDraftRestorer(
      "chat-restore",
      (draft) => {
        applied.push(draft);
        return true;
      },
    );

    expect(tryRestoreLiveChatDraft("chat-restore", restoredDraft)).toBe(true);
    expect(applied).toEqual([restoredDraft]);
    expect(getLiveChatDraft("chat-restore")).toEqual(restoredDraft);
    unregister();
  });

  it("does not overwrite typing that is newer than the failed send", () => {
    const restore = vi.fn(() => true);
    const unregister = registerLiveChatDraftRestorer(
      "chat-restore",
      restore,
    );
    setLiveChatDraft("chat-restore", newerDraft);

    expect(tryRestoreLiveChatDraft("chat-restore", restoredDraft)).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(getLiveChatDraft("chat-restore")).toEqual(newerDraft);
    unregister();
  });
});
