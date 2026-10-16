import { afterEach, describe, expect, it } from "vitest";

import {
  requestDesignSyncAgent,
  resetDesignSyncAgentRequestsForTests,
  takeDesignSyncAgentRequest,
} from "../design-sync-intent";

describe("Design sync agent requests", () => {
  afterEach(() => resetDesignSyncAgentRequestsForTests());

  it("hands each request to exactly one taker, per workspace", () => {
    requestDesignSyncAgent("workspace-a");
    expect(takeDesignSyncAgentRequest("workspace-b")).toBe(false);
    expect(takeDesignSyncAgentRequest("workspace-a")).toBe(true);
    expect(takeDesignSyncAgentRequest("workspace-a")).toBe(false);
  });

  it("stays bounded", () => {
    for (let index = 0; index < 40; index++) requestDesignSyncAgent(`workspace-${index}`);
    expect(takeDesignSyncAgentRequest("workspace-0")).toBe(false);
    expect(takeDesignSyncAgentRequest("workspace-39")).toBe(true);
  });
});
