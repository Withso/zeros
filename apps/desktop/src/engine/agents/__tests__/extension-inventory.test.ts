import { describe, expect, it } from "vitest";
import { collectExtensionInventory } from "../extension-inventory";
import type { ExtensionEntry } from "@zeros/protocol/agent-extensions";

const entry = (id: string): ExtensionEntry => ({
  id,
  name: id,
  description: "",
  sourcePath: "Account",
  status: "configured",
});
const query = { provider: "codex", category: "apps" } as const;
describe("extension source composition", () => {
  it("keeps local declarations when the account returns a complete empty list", async () => {
    const result = await collectExtensionInventory(
      query,
      () => ({ entries: [entry("local")], warnings: [] }),
      async () => ({
        entries: [],
        warnings: [],
        sources: [{ id: "account", kind: "account", state: "complete" }],
      }),
    );
    expect(result.entries.map((item) => item.sourceId)).toEqual(["local"]);
    expect(result.sources?.map((source) => source.state)).toEqual([
      "complete",
      "complete",
    ]);
  });
  it("does not collapse unrelated entries that happen to have the same name or id", async () => {
    const result = await collectExtensionInventory(
      query,
      () => ({ entries: [entry("same")], warnings: [] }),
      async () => ({ entries: [entry("same")], warnings: [] }),
    );
    expect(new Set(result.entries.map((item) => item.id)).size).toBe(2);
  });
  it("reports failed and unsupported sources separately from confirmed emptiness", async () => {
    const local = () => ({ entries: [entry("local")], warnings: [] });
    const failed = await collectExtensionInventory(query, local, async () => {
      throw new Error("secret backend detail");
    });
    expect(failed.sources?.[1].state).toBe("partial");
    expect(failed.entries).toHaveLength(1);
    expect(JSON.stringify(failed)).not.toContain("secret backend detail");
    const unsupported = await collectExtensionInventory(
      { ...query, provider: "cursor" },
      local,
    );
    expect(unsupported.sources?.[1].state).toBe("unsupported");
  });
});
