import { describe, expect, it } from "vitest";
import { localLinkSpans } from "../local-links/model";

// Final review: a retired `zeros-beta://…` token is consumed whole and stays
// inert, so nothing after its `=` can become a clickable link. Expected values
// are origin/main's for the same input.
describe("retired link presentation", () => {
  const SCHEMES = ["zeros", "zeros-alpha", "zeros-dev"] as const;

  it.each(SCHEMES)("finds no link inside a retired token (%s)", (scheme) => {
    expect(localLinkSpans("zeros-beta://chat/old?next=zeros://workspace/example", scheme)).toEqual([]);
    expect(localLinkSpans(`see zeros-beta://chat/old?next=${scheme}://chat/x.`, scheme)).toEqual([]);
  });

  it("still presents a supported link beside a retired one", () => {
    const text = "zeros-beta://chat/old then zeros://chat/new.";
    expect(localLinkSpans(text, "zeros")).toEqual([
      { start: 27, end: 43, href: "zeros://chat/new", link: { scheme: "zeros", kind: "chat", id: "new" } },
    ]);
    expect(localLinkSpans(text, "zeros-dev")).toEqual([]);
  });
});
