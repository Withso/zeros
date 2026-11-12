import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TeamSharingAccessEnded } from "../team-sharing-access-ended";

it("says plainly that access ended, and that drafts stay, with no action to take", () => {
  const html = renderToStaticMarkup(createElement(TeamSharingAccessEnded, { name: "w-7" }));
  expect(html).toContain("You no longer have access to w-7");
  expect(html).toContain("Your drafts stay on this Mac.");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<button");
});
