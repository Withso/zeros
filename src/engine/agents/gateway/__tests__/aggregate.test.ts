import { describe, it, expect } from "vitest";

import {
  aggregateTools,
  gatewayToolName,
  resolveToolCall,
  sanitizeServerName,
  type BackendToolSet,
} from "../aggregate";

describe("sanitizeServerName / gatewayToolName", () => {
  it("keeps safe chars and collapses the rest (so the __ delimiter stays unambiguous)", () => {
    expect(sanitizeServerName("tracker")).toBe("tracker");
    expect(sanitizeServerName("My Server")).toBe("My_Server");
    expect(sanitizeServerName("a.b.c")).toBe("a_b_c");
    expect(sanitizeServerName("weird__name")).toBe("weird_name"); // no double underscores survive
    expect(sanitizeServerName("@scope/pkg")).toBe("scope_pkg");
    expect(sanitizeServerName("")).toBe("server");
    expect(sanitizeServerName("***")).toBe("server");
  });

  it("namespaces a tool as <server>__<tool>", () => {
    expect(gatewayToolName("tracker", "create_issue")).toBe("tracker__create_issue");
    expect(gatewayToolName("My Server", "do")).toBe("My_Server__do");
  });
});

describe("aggregateTools", () => {
  const sets: BackendToolSet[] = [
    { server: "tracker", tools: [{ name: "create_issue", description: "x" }, { name: "search" }] },
    { server: "github", tools: [{ name: "search", inputSchema: { type: "object" } }] },
  ];

  it("merges backends into one namespaced union, preserving order + passthrough fields", () => {
    const { tools } = aggregateTools(sets);
    expect(tools.map((t) => t.name)).toEqual(["tracker__create_issue", "tracker__search", "github__search"]);
    expect(tools[0]!.description).toBe("x"); // passthrough
    expect(tools[2]!.inputSchema).toEqual({ type: "object" }); // passthrough
  });

  it("same tool name on two backends does NOT collide (that's the point of namespacing)", () => {
    const { route, warnings } = aggregateTools(sets);
    expect(route.get("tracker__search")).toEqual({ server: "tracker", tool: "search" });
    expect(route.get("github__search")).toEqual({ server: "github", tool: "search" });
    expect(warnings).toEqual([]);
  });

  it("routes a namespaced call back to the backend + original tool name", () => {
    const { route } = aggregateTools(sets);
    expect(resolveToolCall(route, "tracker__create_issue")).toEqual({ server: "tracker", tool: "create_issue" });
    expect(resolveToolCall(route, "nope__missing")).toBeNull();
  });

  it("warns + keeps-first when two backend names sanitize to the same prefix", () => {
    const { tools, warnings } = aggregateTools([
      { server: "a.b", tools: [{ name: "t" }] },
      { server: "a_b", tools: [{ name: "t" }] }, // sanitizes to the same "a_b" → collides
    ]);
    expect(tools.map((t) => t.name)).toEqual(["a_b__t"]);
    expect(warnings.some((w) => /collides/.test(w))).toBe(true);
  });

  it("drops a malformed (nameless) tool with a warning", () => {
    const { tools, warnings } = aggregateTools([
      { server: "s", tools: [{ name: "" }, { foo: "bar" } as never, { name: "ok" }] },
    ]);
    expect(tools.map((t) => t.name)).toEqual(["s__ok"]);
    expect(warnings.filter((w) => /no name/.test(w))).toHaveLength(2);
  });

  it("handles an empty backend set", () => {
    const { tools, route, warnings } = aggregateTools([]);
    expect(tools).toEqual([]);
    expect(route.size).toBe(0);
    expect(warnings).toEqual([]);
  });
});
