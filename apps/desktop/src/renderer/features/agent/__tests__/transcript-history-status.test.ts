import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useTranscriptHistoryStatus } from "../use-transcript-history-status";

function Status(props: Parameters<typeof useTranscriptHistoryStatus>[0]) {
  return createElement("output", null, useTranscriptHistoryStatus(props));
}
describe("known-empty transcript presentation", () => {
  it("does not call a resident new chat unavailable because its CP head is incomplete", () => {
    expect(renderToStaticMarkup(createElement(Status, { identity: "new-cloud", active: true,
      hasMessages: false, hasTranscript: false, resident: true, incomplete: true }))).toBe("<output>none</output>");
  });
  it.each([true, false])("retains incomplete-history feedback for known prior rows (resident=%s)", resident => {
    expect(renderToStaticMarkup(createElement(Status, { identity: "existing-cloud", active: true,
      hasMessages: false, hasTranscript: true, resident, incomplete: true }))).toBe("<output>unavailable</output>");
  });
});
