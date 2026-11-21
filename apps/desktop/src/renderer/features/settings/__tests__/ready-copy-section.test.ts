// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ reply: null as unknown, build: vi.fn(async () => ({})), output: vi.fn(async () => "npm ERR! [redacted]") }));
vi.mock("../../../platform/cloud-github-levels", async original => ({
  ...(await original<typeof import("../../../platform/cloud-github-levels")>()),
  getCloudReadyCopy: vi.fn(async () => fixture.reply),
  buildCloudReadyCopy: fixture.build,
  getCloudReadyCopyOutput: fixture.output,
}));

import { ReadyCopySection, readyCopyStatusLine } from "../ready-copy-section";

const ORG = "11111111-1111-4111-8111-111111111111";
const hour = 3_600_000, day = 24 * hour, iso = (offset: number) => new Date(Date.now() + offset).toISOString();
let container: HTMLDivElement, root: Root, repository = 0;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  fixture.build.mockClear(); fixture.output.mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (reply: unknown) => {
  fixture.reply = reply;
  await act(async () => { root.render(createElement(ReadyCopySection, { organizationId: ORG, repository: `withso/r${repository++}`, active: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return (container.textContent ?? "").replace(/&#x27;/g, "'");
};
const button = (name: string) => [...container.querySelectorAll("button")].find(node => node.textContent === name);

describe("a repository's ready copy on its project page", () => {
  it("shows admins the failure in plain words, where, the next retry, the history with why each ran, output and Retry now", async () => {
    const text = await render({ canBuild: true,
      status: { state: "update_failed", updatedAt: iso(-3 * day), nextUpdateAt: iso(4 * day),
        failure: { reason: "ready_copy_secret_left", detail: "/home/user/withso/zeros/.npmrc", failures: 1, nextRetryAt: iso(hour) } },
      history: [
        { generation: 4, state: "failed", startedAt: iso(-2 * hour), finishedAt: iso(-2 * hour + 300_000), commit: null, branch: null, trigger: "manual",
          startedBy: "Alice", failure: { reason: "ready_copy_secret_left", detail: "/home/user/withso/zeros/.npmrc" }, output: true },
        { generation: 3, state: "ready", startedAt: iso(-3 * day), finishedAt: iso(-3 * day + 120_000), commit: "c".repeat(40), branch: "main",
          trigger: "weekly_update", startedBy: null, failure: null, output: false },
      ] });
    expect(text).toContain("Update failed. New workspaces still use the copy from 3d ago.");
    expect(text).toContain("In /home/user/withso/zeros/.npmrc. Read it from the environment in setup; don't write it to a file.");
    expect(text).toMatch(/Next try in (59|60) minutes/);
    expect(text).toContain("Started by Alice");
    expect(text).toContain("Weekly update");
    expect(text).toContain("main @ ccccccc");
    expect(text).not.toMatch(/ready_copy_/);
    await act(async () => { button("Output")!.click(); });
    expect(fixture.output).toHaveBeenCalledWith(ORG, expect.stringMatching(/^withso\/r/), 4);
    await act(async () => { button("Retry now")!.click(); });
    expect(fixture.build).toHaveBeenCalledOnce();
  });

  it("shows members the status line only", async () => {
    const text = await render({ status: { state: "ready", updatedAt: iso(-day), nextUpdateAt: iso(6 * day) } });
    expect(text).toContain("Ready · updated 1d ago · next update in 6 days");
    expect(button("Build now")).toBeUndefined();
    expect(container.querySelector('[aria-label="Ready copy builds"]')).toBeNull();
    expect(await render({ status: { state: "none", updatedAt: null, nextUpdateAt: null } })).toBe("");
  });

  it("names every state", () => {
    const now = Date.now();
    expect(readyCopyStatusLine({ state: "updating", updatedAt: null, nextUpdateAt: null }, now)).toBe("Updating… The previous copy still serves new workspaces.");
    expect(readyCopyStatusLine({ state: "getting_ready", updatedAt: null, nextUpdateAt: null }, now)).toBe("Getting ready…");
    expect(readyCopyStatusLine({ state: "failed", updatedAt: null, nextUpdateAt: null }, now)).toContain("clone the repository directly");
    expect(readyCopyStatusLine({ state: "none", updatedAt: null, nextUpdateAt: null }, now)).toBeNull();
  });
});
