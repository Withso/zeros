import { describe, expect, it } from "vitest";

import type { ChatThread } from "../../../state/store";
import { buildForkTranscriptAttachment, createForkedChat } from "../fork-chat";

const source: ChatThread = {
  id: "source-chat",
  folder: "/repo",
  kind: "chat",
  agentId: "cursor",
  agentName: "Cursor",
  model: "composer-2.5",
  effort: "high",
  fast: true,
  additionalDirectories: ["/repo/shared"],
  permissionMode: "tool-approval",
  lastModeId: "ask",
  prePlanModeId: "auto",
  title: "Investigate a race",
  createdAt: 10,
  updatedAt: 20,
  sessionId: "zeros-execution",
  providerBinding: {
    version: 1,
    providerId: "cursor",
    kind: "native",
    resumeId: "provider-session",
  },
  providerMetadata: {
    version: 1,
    git: { sha: "abc", branch: "main", originUrl: null },
  },
  pinned: true,
  archived: true,
};

describe("Zeros-native chat fork", () => {
  it("copies product settings but never clones live/provider identity", () => {
    expect(createForkedChat(source, "fork-chat", 100)).toEqual({
      id: "fork-chat",
      folder: "/repo",
      kind: "chat",
      agentId: "cursor",
      agentName: "Cursor",
      model: "composer-2.5",
      effort: "high",
      fast: true,
      additionalDirectories: ["/repo/shared"],
      permissionMode: "tool-approval",
      lastModeId: "ask",
      prePlanModeId: "auto",
      title: "Untitled",
      createdAt: 100,
      updatedAt: 100,
      sourceChatId: "source-chat",
    });
  });

  it("builds one removable concise transcript attachment", () => {
    const built = buildForkTranscriptAttachment({
      sourceChatId: "source-chat",
      sourceLabel: "Investigate a race",
      text: "# Investigate a race\n",
    });

    expect(built.name).toBe("investigate-a-race.concise.txt");
    expect(built.sourceKey).toBe("transcript:source-chat");
    expect(built.text).toBe("# Investigate a race\n");
  });

  it("marks an attachment whose older source history could not be loaded", () => {
    const built = buildForkTranscriptAttachment({
      sourceChatId: "source-chat",
      sourceLabel: "Investigate a race",
      text: "# Investigate a race\n",
      complete: false,
    });

    expect(built.text).toContain("# Investigate a race");
    expect(built.text).toContain("Earlier messages were omitted");
  });
});
