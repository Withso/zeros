import { describe, expect, it } from "vitest";

import { DESIGN_COMPONENT_BINDINGS_PARAM, designFrameComponentSchema, designFrameInstanceComponentSchema } from "@zeros/protocol/design-catalog";
import { designReplyForOlderRenderer, takeDesignNegotiation } from "../options-shows-compat";

const bindings = { root: "btn", layers: { btn: { styles: { height: ["size"] } }, "btn-label": { text: ["label"] } }, gates: { "data-size": ["size"] } };
const component = { elements: [], reach: {}, bindings };
const instanceComponent = { elements: [], reach: {}, file: "button.html", frame: true, bindings };
const frame = { file: "home.html", component, instances: { key: "0".repeat(16), components: { button: instanceComponent }, hosts: {} } };
// What a renderer that predates bindings parses: the same records without the key.
const olderComponent = designFrameComponentSchema.omit({ bindings: true }).strict();
const olderInstanceComponent = designFrameInstanceComponentSchema.omit({ bindings: true }).strict();

describe("which controls each main layer reads, on the wire", () => {
  it("reaches no renderer that did not negotiate it, in any reply that carries frames", () => {
    expect(olderComponent.safeParse(component).success).toBe(false);
    for (const reply of [{ frames: [frame] }, { frame }, { snapshot: { frames: [frame] } }, { prepared: [frame] }]) {
      const older = JSON.stringify(designReplyForOlderRenderer(reply, { showsNothing: true, slotText: true, bindings: false }));
      expect(older).not.toContain('"bindings"');
    }
    const older = designReplyForOlderRenderer({ frames: [frame] }) as { frames: Array<typeof frame> };
    expect(olderComponent.safeParse(older.frames[0]!.component).success).toBe(true);
    expect(olderInstanceComponent.safeParse(older.frames[0]!.instances.components.button).success).toBe(true);
    // Only the key goes; the rest of the record is as computed.
    expect(older.frames[0]!.instances.key).toBe(frame.instances.key);
  });

  it("reaches a renderer that negotiated it unchanged, and validates", () => {
    const reply = { frames: [frame] };
    expect(designReplyForOlderRenderer(reply, { showsNothing: true, slotText: true, bindings: true })).toBe(reply);
    expect(designFrameComponentSchema.safeParse(component).success).toBe(true);
    expect(designFrameInstanceComponentSchema.safeParse(instanceComponent).success).toBe(true);
  });

  it("splits its request flag off before dispatch", () => {
    expect(takeDesignNegotiation({ a: 1, [DESIGN_COMPONENT_BINDINGS_PARAM]: true }))
      .toEqual({ params: { a: 1 }, negotiated: { showsNothing: false, slotText: false, bindings: true } });
  });
});
