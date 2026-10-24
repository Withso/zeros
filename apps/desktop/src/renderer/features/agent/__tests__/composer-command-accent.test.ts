import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { slashCommandDecorations } from "../composer-editor/slash-command-decoration";

const schema = new Schema({ nodes: { doc: { content: "paragraph+" }, paragraph: { content: "text*" }, text: {} } });
const commands = [{ name: "init", description: "Initialize" }, { name: "compact", description: "Compact" }, { name: "review", description: "Skill", kind: "skill" as const }];
const decorated = (text: string) => {
  const doc = schema.node("doc", null, [schema.node("paragraph", null, text ? schema.text(text) : undefined)]);
  return slashCommandDecorations(doc, commands).find().map(({ from, to }) => doc.textBetween(from, to));
};

describe("composer command accents", () => {
  it("highlights commands at the beginning and within prose without coloring arguments", () => {
    expect(decorated("/init please, then /compact keep the architecture")).toEqual(["/init", "/compact"]);
  });
  it("does not mistake skills, unknown commands, paths or URLs for commands", () => {
    expect(decorated("/review /unknown /init/config src/init https://example.test/init /initialize")).toEqual([]);
  });
  it("accepts tabs, newlines and punctuation and leaves the actual prompt unchanged", () => {
    expect(decorated("Next\t/init, then\n/compact.")).toEqual(["/init", "/compact"]);
    expect(decorated("")).toEqual([]);
  });
});
