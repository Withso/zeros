import { describe, expect, it } from "vitest";
import {
  sessionToolGroups,
  sessionToolsInventorySnapshotSchema,
  sessionToolsSnapshotSchema,
} from "../agent-extensions";

const legacy = {
  state: "ready",
  entries: [{ id: "mcp", name: "MCP", status: "connected" }],
} as const;

describe("session tool inventory wire compatibility", () => {
  it("retains the legacy strict list and accepts grouped inventory through its own schema", () => {
    const groups = [
      {
        kind: "apps",
        state: "ready",
        entries: [{ id: "a", name: "App", status: "available" }],
      },
    ];
    expect(sessionToolsSnapshotSchema.safeParse(legacy).success).toBe(true);
    expect(
      sessionToolsSnapshotSchema.safeParse({ ...legacy, groups }).success,
    ).toBe(false);
    expect(
      sessionToolsInventorySnapshotSchema.parse({ ...legacy, groups }).groups,
    ).toEqual(groups);
  });
  it("distinguishes unavailable category discovery from an authoritative zero count", () => {
    const snapshot = sessionToolsInventorySnapshotSchema.parse(legacy);
    expect(
      sessionToolGroups(snapshot).map((group) => [
        group.kind,
        group.state,
        group.entries.length,
      ]),
    ).toEqual([
      ["plugins", "unsupported", 0],
      ["apps", "unsupported", 0],
      ["mcp", "ready", 1],
    ]);
    expect(
      sessionToolGroups({
        ...snapshot,
        groups: [{ kind: "apps", state: "ready", entries: [] }],
      })[1].state,
    ).toBe("ready");
  });
  it("marks locally configured connections only inside grouped inventory", () => {
    const local = { id: "repo", name: "repo", status: "connected", source: "local" };
    expect(
      sessionToolsInventorySnapshotSchema.parse({
        ...legacy,
        groups: [{ kind: "mcp", state: "ready", entries: [local] }],
      }).groups?.[0].entries[0].source,
    ).toBe("local");
    // The legacy list stays strict for older clients.
    expect(
      sessionToolsSnapshotSchema.safeParse({ ...legacy, entries: [local] })
        .success,
    ).toBe(false);
    expect(
      sessionToolsInventorySnapshotSchema.safeParse({
        ...legacy,
        groups: [
          { kind: "mcp", state: "ready", entries: [{ ...local, source: "plugin" }] },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects duplicate categories and unexpected provider fields", () => {
    const group = { kind: "apps", state: "ready", entries: [] };
    expect(
      sessionToolsInventorySnapshotSchema.safeParse({
        ...legacy,
        groups: [group, group],
      }).success,
    ).toBe(false);
    expect(
      sessionToolsInventorySnapshotSchema.safeParse({
        ...legacy,
        groups: [{ ...group, token: "SECRET" }],
      }).success,
    ).toBe(false);
  });
});
