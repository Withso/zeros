import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ActingAsLabel, actingAsName } from "../acting-as";

const me = "11111111-1111-4111-8111-111111111111", alex = "44444444-4444-4444-8444-444444444444";
const roster = [{ id: alex, name: "Alex Rivera", avatarUrl: null }] as Parameters<typeof actingAsName>[2];

it("names the running turn's person, says you for the viewer's own turn, and nothing without one", () => {
  expect(actingAsName(alex, me, roster)).toBe("Alex Rivera");
  expect(actingAsName(me, me, roster)).toBe("you");
  expect(actingAsName("55555555-5555-4555-8555-555555555555", me, roster)).toBe("A teammate");
  expect(actingAsName(null, me, roster)).toBeNull();
  expect(renderToStaticMarkup(createElement(ActingAsLabel, { name: "Alex Rivera" }))).toContain("Acting as Alex Rivera");
});
