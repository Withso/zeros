import { describe, expect, it } from "vitest";

import { DESIGN_INSTANCE_SLOT_TEXT_PARAM, DESIGN_OPTIONS_SHOW_NOTHING_PARAM } from "@zeros/protocol/design-catalog";
import { designReplyForOlderRenderer, takeDesignNegotiation } from "../options-shows-compat";

const hosts = {
  mixed: { component: "card", attributes: {}, text: "Hi ", mixedText: true as const },
  plain: { component: "card", attributes: {}, text: "Only" },
};
const reply = { frames: [{ file: "a.html", instances: { components: {}, hosts } }] };

describe("text beside an instance host's children", () => {
  it("reaches only a renderer that negotiated slot text; others keep text on hosts holding nothing else", () => {
    const older = designReplyForOlderRenderer(reply) as typeof reply;
    expect(older.frames[0]!.instances.hosts).toEqual({ mixed: { component: "card", attributes: {} }, plain: hosts.plain });
    expect(designReplyForOlderRenderer(reply, { showsNothing: true, slotText: true, bindings: true })).toBe(reply);
    expect(designReplyForOlderRenderer({ snapshot: reply }, { showsNothing: true, slotText: false, bindings: true }))
      .toEqual({ snapshot: { frames: [{ file: "a.html", instances: { components: {}, hosts: { mixed: { component: "card", attributes: {} }, plain: hosts.plain } } }] } });
  });

  it("splits both negotiation flags off a request before it is dispatched", () => {
    expect(takeDesignNegotiation({ a: 1, [DESIGN_OPTIONS_SHOW_NOTHING_PARAM]: true, [DESIGN_INSTANCE_SLOT_TEXT_PARAM]: true }))
      .toEqual({ params: { a: 1 }, negotiated: { showsNothing: true, slotText: true, bindings: false } });
    expect(takeDesignNegotiation({ a: 1, [DESIGN_INSTANCE_SLOT_TEXT_PARAM]: true }))
      .toEqual({ params: { a: 1 }, negotiated: { showsNothing: false, slotText: true, bindings: false } });
    const plain = { a: 1 };
    expect(takeDesignNegotiation(plain)).toEqual({ params: plain, negotiated: { showsNothing: false, slotText: false, bindings: false } });
  });
});
