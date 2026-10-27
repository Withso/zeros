import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it } from "vitest";
import type { DesignFrameDocumentWire } from "../../../platform/git";
import { designFrameDocumentCache, designFrameDocumentKey } from "../state/design-workspace-cache";
import { useDesignFrameDocument } from "../state/use-design-frame-document";

const file = "home.html";
const version = "a".repeat(24);
const empty = "<!doctype html><html><body></body></html>";

function seed(owner: string, sourceVersion = version) {
  const source = `<html><body>${owner}:${sourceVersion}</body></html>`;
  const document: DesignFrameDocumentWire = { file, title: "Home", width: 100, height: 100,
    x: 0, y: 0, z: 0, nodeCount: 1, modifiedAt: 1, sourceVersion, source, srcDoc: source, tree: [] };
  designFrameDocumentCache.setData(designFrameDocumentKey(owner, file, sourceVersion), document);
}

function Frame({ owner, sourceVersion, active }: { owner: string; sourceVersion: string; active: boolean }) {
  const document = useDesignFrameDocument(owner, file, sourceVersion, active);
  return React.createElement("iframe", { srcDoc: document.data?.srcDoc ?? empty });
}

const render = (owner: string, active: boolean, sourceVersion = version) =>
  renderToStaticMarkup(React.createElement(Frame, { owner, active, sourceVersion }));

beforeEach(() => designFrameDocumentCache.clear());

it.each(["personal", "organization-local"])("keeps %s's loaded fallback document intact while hidden", owner => {
  seed(owner);
  expect(render(owner, false)).toBe(render(owner, true));
});

it("keeps a hidden Personal → organization → Personal return keyed to each exact document", () => {
  seed("personal");
  seed("organization-local");
  const personal = render("personal", true);
  const organization = render("organization-local", true);
  expect(personal).not.toBe(organization);
  expect(render("personal", false)).toBe(personal);
  expect(render("organization-local", false)).toBe(organization);
  expect(render("personal", false)).toBe(personal);
});

it("does not borrow another owner or source when the disabled exact key is cold", () => {
  seed("personal");
  const cold = render("missing", false);
  expect(render("organization-local", false)).toBe(cold);
  expect(render("personal", false, "b".repeat(24))).toBe(cold);
  expect(cold).not.toBe(render("personal", true));
});

it("retains only the newly requested cached generation after a source change", () => {
  seed("personal");
  const next = "b".repeat(24);
  seed("personal", next);
  expect(render("personal", false, next)).toBe(render("personal", true, next));
  expect(render("personal", false, next)).not.toBe(render("personal", true));
});

it("does not admit unused disabled fallbacks or evict loaded documents at the cache bound", () => {
  const owners = Array.from({ length: 16 }, (_, index) => `loaded-${index}`);
  for (const owner of owners) seed(owner);
  const retained = owners.map(owner => designFrameDocumentCache.peekSnapshot(designFrameDocumentKey(owner, file, version)).data);
  for (let index = 0; index < 64; index++) render(`unused-protocol-${index}`, false);
  for (const [index, owner] of owners.entries())
    expect(designFrameDocumentCache.peekSnapshot(designFrameDocumentKey(owner, file, version)).data).toBe(retained[index]);
});
