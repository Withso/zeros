import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TEAM_WRITING_NOTICE, TeamWritingNoticeText } from "../team-writing-notice";

it("says plainly that members can read a running turn's login and personal secrets", () => {
  expect(TEAM_WRITING_NOTICE).toMatch(/members can read the agent login and personal secrets/);
  expect(renderToStaticMarkup(createElement(TeamWritingNoticeText))).toContain("data-team-writing-notice");
});
