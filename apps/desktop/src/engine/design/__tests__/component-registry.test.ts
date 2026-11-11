import { describe, expect, it } from "vitest";

import { designComponentRegistry } from "../component-registry";
import type { CanvasDocument } from "../document-model";
import { designFrameIdentityContext } from "../identity-cache";

const canvas = (info: Record<string, Record<string, unknown>>): CanvasDocument =>
  ({
    version: 3,
    pages: [{ id: "p", title: "Home", folder: "home", frames: Object.values(info).map((entry) => entry.id as string) }],
    frames: Object.fromEntries(Object.keys(info).map((file) => [file, { x: 0, y: 0, w: 100, h: 100, z: 0 }])),
    frame_info: Object.fromEntries(Object.entries(info).map(([file, entry]) => [file, { title: file, kind: "frame", ...entry }])),
  }) as unknown as CanvasDocument;

describe("frames registered as components", () => {
  it("map each registered name to its frame", () => {
    const registry = designComponentRegistry(canvas({ "home/a.html": { id: "a", component: "chat-composer" }, "home/b.html": { id: "b" } }));
    expect([...registry.files]).toEqual([["chat-composer", "home/a.html"]]);
    expect(registry.problems).toEqual([]);
  });

  it("refuse a name registered twice, on both frames, and resolve neither", () => {
    const registry = designComponentRegistry(canvas({ "home/a.html": { id: "a", component: "card" }, "home/b.html": { id: "b", component: "card" } }));
    expect(registry.files.size).toBe(0);
    expect(registry.problems.map((problem) => problem.file)).toEqual(["home/a.html", "home/b.html"]);
    expect(registry.problems[0]!.message).toBe("zd-card is registered by 2 frames (home/a.html, home/b.html); each component needs its own name.");
  });

  it("refuse names that are not tag names, or that Zeros keeps", () => {
    for (const name of ["Card", "card_x", "-card", "card-", "", "option", "variant", "for", 7]) {
      const registry = designComponentRegistry(canvas({ "home/a.html": { id: "a", component: name } }));
      expect(registry.files.size, String(name)).toBe(0);
      expect(registry.problems, String(name)).toHaveLength(1);
    }
  });
});

describe("a frame's identity", () => {
  it("changes when what its component names resolve to changes", () => {
    const before = canvas({ "home/a.html": { id: "a" }, "home/b.html": { id: "b" } });
    const after = canvas({ "home/a.html": { id: "a" }, "home/b.html": { id: "b", component: "card" } });
    expect(designFrameIdentityContext(after, "home/a.html", "p")).not.toBe(designFrameIdentityContext(before, "home/a.html", "p"));
  });

  it("is unchanged for a canvas that registers no component", () => {
    // Computed by the identity cache before components could be registered.
    const plain = canvas({ "home/a.html": { id: "a" } });
    expect(designFrameIdentityContext(plain, "home/a.html", "p")).toBe("5b6c936b221a719edf234aa7d31aae57767e61b0e9e551b0aedfb755b0fa56eb");
  });
});
