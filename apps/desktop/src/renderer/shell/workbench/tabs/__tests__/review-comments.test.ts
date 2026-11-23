// @vitest-environment jsdom

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CommentsSection } from "../review-comments";

const render = (props: { loading?: boolean; incomplete?: boolean }) =>
  renderToString(
    createElement(CommentsSection, { items: [], owner: "ws", prNumber: 1, cwd: "/repo", onAddToChat: () => {}, ...props }),
  );

describe("Comments read state", () => {
  it("never calls an unread or partly read list empty", () => {
    expect(render({ loading: true })).toContain('aria-busy="true"');
    expect(render({ incomplete: true })).toContain("may be incomplete");
    expect(render({ incomplete: true })).not.toContain("No comments yet");
    expect(render({})).toContain("No comments yet.");
  });
});
