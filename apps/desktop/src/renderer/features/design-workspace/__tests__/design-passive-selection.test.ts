import { describe, expect, it } from "vitest";
import { DesignPassiveSelectionPublisher, type DesignPassiveSelection } from "../state/design-passive-selection";

const frame = { file: "page-1/home.html", sourceVersion: undefined as string | undefined, title: "Home", x: 0, y: 0, width: 1440, height: 900 };
const selection = (patch: Partial<DesignPassiveSelection> = {}): DesignPassiveSelection => ({
  workspaceId: "ws", owner: { directoryId: "design_1", pageId: "page_1", revision: 1 }, frame, selected: false, event: undefined, ...patch,
});

describe("passive Design selection publication", () => {
  it("publishes a selection once while snapshot updates leave it unchanged", () => {
    const publisher = new DesignPassiveSelectionPublisher();
    // A lazily prepared 1,000-frame open updates its snapshot about 64 times.
    const published = Array.from({ length: 64 }, () => publisher.offer(selection())).filter(Boolean);
    expect(published).toHaveLength(1);
  });

  it("publishes again when anything the engine is told changes", () => {
    const publisher = new DesignPassiveSelectionPublisher();
    expect(publisher.offer(selection())).toBe(true);
    // The frame's preparation lands: the durable selection carries its version.
    expect(publisher.offer(selection({ frame: { ...frame, sourceVersion: "a".repeat(24) } }))).toBe(true);
    expect(publisher.offer(selection({ frame: { ...frame, sourceVersion: "a".repeat(24) } }))).toBe(false);
    expect(publisher.offer(selection({ frame: { ...frame, sourceVersion: "a".repeat(24), x: 40 } }))).toBe(true);
    expect(publisher.offer(selection({ frame: { ...frame, sourceVersion: "a".repeat(24), x: 40 }, selected: true }))).toBe(true);
    expect(publisher.offer(selection({ frame: null }))).toBe(true);
    expect(publisher.offer(selection({ frame: null, event: 3 }))).toBe(true);
    expect(publisher.offer(selection({ frame: null, event: 3, owner: { directoryId: "design_1", pageId: "page_2", revision: 1 } }))).toBe(true);
    expect(publisher.offer(selection({ frame: null, event: 3, owner: { directoryId: "design_1", pageId: "page_2", revision: 1 }, workspaceId: "other" }))).toBe(true);
  });

  it("publishes again after a reconnect, since the engine forgot it", () => {
    const publisher = new DesignPassiveSelectionPublisher();
    expect(publisher.offer(selection())).toBe(true);
    expect(publisher.offer(selection())).toBe(false);
    publisher.forget();
    expect(publisher.offer(selection())).toBe(true);
  });
});
