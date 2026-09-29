import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const source = readFileSync(new URL("../agent-chat.tsx", import.meta.url), "utf8");
it("measures visible archived history without requiring an interactive composer", () => {
  expect(source).toMatch(/useCloudTranscriptLatency\([^;]+chatId, surfaceActive,/s);
});
it("requires an actual resident session slot before recording a transcript paint", () => {
  expect(source).toMatch(/const transcriptPaintReady = useSessionsStore\(\(s\) =>\s*!!chatId && s.sessions\[chatId\]\?\.transcriptState === "resident"/);
  expect(source).toMatch(/useCloudTranscriptLatency\([^;]+transcriptPaintReady, hasSessionMessages\)/s);
});
it("does not promote cloud intent peers by reading files from a hidden prepared transcript", () => {
  const start = source.indexOf("const cwd = chatFileOpenCwd");
  const effect = source.slice(start, source.indexOf("const updateChatSettings", start));
  expect(effect).toContain("surfaceActive || !isCloudWorkspace(cwd)");
});
