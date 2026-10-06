import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { WorkbenchTabFrame } from "../tab-status";
import { workbenchSourcesFor, workbenchStatusKey, type WorkbenchStatus } from "../tab-status-model";

const fixture = vi.hoisted(() => ({ status: null as WorkbenchStatus | null, connection: "connected", visible: true }));
vi.mock("../../../state/workbench-availability", () => ({
  useWorkbenchAvailability: () => ({ status: fixture.status, availability: { connection: fixture.connection }, visible: fixture.visible }),
  registerWorkbenchFrameVisibility: () => () => {}, reconnectWorkbenchWorkspace: vi.fn(),
}));
const tab = { id: "changes-notice", type: "changes" as const, title: "Changes" };
const sources = () => workbenchSourcesFor(workbenchStatusKey("/notice", tab));
const render = () => renderToStaticMarkup(createElement(WorkbenchTabFrame,
  { tab, folder: "/notice", active: true, children: createElement("span", null, "Existing content") }));
afterEach(() => {
  sources().remove("history"); sources().remove("body");
  fixture.status = null; fixture.connection = "connected"; fixture.visible = true;
});
it("uses one neutral banner without blocking content, below availability and load failures", () => {
  sources().update("history", { pending: false, notice: { tone: "neutral", message: "Shallow Git history",
    action: { label: "Fetch full history", busyLabel: "Fetching…", busy: false, run: vi.fn() } } });
  let markup = render();
  expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
  expect(markup).toContain("Shallow Git history"); expect(markup).toContain("Fetch full history");
  expect(markup).toContain("Existing content"); expect(markup).not.toContain("data-workbench-empty");
  sources().update("body", { pending: false, error: "failed", primary: true });
  markup = render();
  expect(markup).toContain("load changes"); expect(markup).not.toContain("Shallow Git history");
  fixture.status = { tone: "neutral", message: "This workspace is stopped." };
  markup = render();
  expect(markup).toContain("This workspace is stopped."); expect(markup).not.toContain("load changes");
  expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
  sources().remove("body"); fixture.status = null; fixture.connection = "disconnected";
  expect(render()).not.toContain("Shallow Git history");
  fixture.connection = "connected"; fixture.visible = false;
  expect(render()).toContain("disabled=\"\"");
});
it("keeps Local tabs without a notice on their existing error and recovery path", () => {
  expect(render()).not.toContain("Fetch full history");
  sources().update("body", { pending: false, primary: true, error: "failed" });
  expect(render()).toContain("Retry loading changes");
  sources().update("body", { pending: false, primary: true, hasContent: true });
  const markup = render();
  expect(markup.match(/data-workbench-banner=/g)).toHaveLength(1);
  expect(markup).not.toContain("Retry loading"); expect(markup).not.toContain("data-workbench-empty");
  expect(markup).toContain("Existing content");
});
