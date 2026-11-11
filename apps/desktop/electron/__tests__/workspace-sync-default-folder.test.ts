import { describe, expect, it } from "vitest";
import { defaultSyncFolder } from "../workspace-sync/default-folder";

describe("the default sync folder (12.z)", () => {
  it("is <channel folder>/cloud-sync/<repository>/<workspace> (12.zz: ~/zeros, ~/zeros-alpha, ~/zeros-beta), one plain segment each, never outside", () => {
    expect(defaultSyncFolder("/Users/alex/zeros-alpha", "zeros", "w-19")).toBe("/Users/alex/zeros-alpha/cloud-sync/zeros/w-19");
    expect(defaultSyncFolder("/Users/alex/zeros", "zeros", "w-19")).toBe("/Users/alex/zeros/cloud-sync/zeros/w-19");
    expect(defaultSyncFolder("/Users/alex/zeros-beta", "../../etc", "a/b\\c:d")).toBe("/Users/alex/zeros-beta/cloud-sync/etc/a-b-c-d");
    expect(defaultSyncFolder("/Users/alex/zeros-alpha", ".hidden", "..")).toBe("/Users/alex/zeros-alpha/cloud-sync/hidden/workspace");
    expect(defaultSyncFolder("/Users/alex/zeros-alpha", "", "Fix login\u0000\n")).toBe("/Users/alex/zeros-alpha/cloud-sync/repository/Fix login");
    expect(defaultSyncFolder("/Users/alex/zeros-alpha", "r", "x".repeat(200)).split("/").at(-1)).toHaveLength(80);
  });

  it("names the channel folder from the workspaces root, as the app's channel does", async () => {
    const { syncChannelFolder } = await import("../workspace-sync/default-folder");
    expect(syncChannelFolder("/Users/alex/zeros-alpha/workspaces")).toBe("/Users/alex/zeros-alpha");
    expect(syncChannelFolder("/Users/alex/zeros-dev-wt1/workspaces")).toBe("/Users/alex/zeros-dev-wt1");
  });
});
