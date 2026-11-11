import { describe, expect, it } from "vitest";
import { defaultSyncFolder } from "../workspace-sync/default-folder";

describe("the default sync folder (12.z)", () => {
  it("is ~/zeros/cloud-sync/<repository>/<workspace>, one plain segment each, never outside", () => {
    expect(defaultSyncFolder("/Users/alex", "zeros", "w-19")).toBe("/Users/alex/zeros/cloud-sync/zeros/w-19");
    expect(defaultSyncFolder("/Users/alex", "../../etc", "a/b\\c:d")).toBe("/Users/alex/zeros/cloud-sync/etc/a-b-c-d");
    expect(defaultSyncFolder("/Users/alex", ".hidden", "..")).toBe("/Users/alex/zeros/cloud-sync/hidden/workspace");
    expect(defaultSyncFolder("/Users/alex", "", "Fix login\u0000\n")).toBe("/Users/alex/zeros/cloud-sync/repository/Fix login");
    expect(defaultSyncFolder("/Users/alex", "r", "x".repeat(200)).split("/").at(-1)).toHaveLength(80);
  });
});
