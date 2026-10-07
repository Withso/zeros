import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudTranscriptCacheNotice } from "../cloud-transcript-cache-notice";
const chatId = "cloud:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222:chat-a";
describe("cached transcript provenance", () => {
  it("marks a provisional cloud transcript and clears the notice on confirmation", () => {
    expect(renderToStaticMarkup(createElement(CloudTranscriptCacheNotice, { chatId, cached: true }))).toContain('role="status">Cached');
    expect(renderToStaticMarkup(createElement(CloudTranscriptCacheNotice, { chatId, cached: false }))).toBe("");
  });
  it("never adds a cached notice to either Local placement", () => {
    for (const localId of ["personal-local-chat", "org-local-chat"])
      expect(renderToStaticMarkup(createElement(CloudTranscriptCacheNotice, { chatId: localId, cached: true }))).toBe("");
  });
});
