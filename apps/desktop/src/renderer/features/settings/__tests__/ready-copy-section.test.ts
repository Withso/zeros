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

import { ReadyCopySection, readyCopyStatus } from "../ready-copy-section";

const ORG = "11111111-1111-4111-8111-111111111111";
const hour = 3_600_000, day = 24 * hour, iso = (offset: number) => new Date(Date.now() + offset).toISOString();
let container: HTMLDivElement, root: Root, project = 0;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  fixture.build.mockClear(); fixture.output.mockClear();
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
const render = async (reply: unknown) => {
  fixture.reply = reply;
  await act(async () => { root.render(createElement(ReadyCopySection, { organizationId: ORG, projectId: `88888888-8888-4888-8888-${String(project++).padStart(12, "0")}`, active: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return (container.textContent ?? "").replace(/&#x27;/g, "'");
};
const button = (name: string) => [...container.querySelectorAll("button")].find(node => node.textContent === name);

describe("a project's ready copy on its project page", () => {
  it("shows admins the failure in plain words, where, the next retry, the history with why each ran, output and Retry now", async () => {
    const text = await render({ canBuild: true,
      status: { state: "update_failed", updatedAt: iso(-3 * day), nextUpdateAt: iso(4 * day),
        failure: { reason: "ready_copy_secret_left", repository: "withso/zeros", step: "secret_search", detail: "/home/user/withso/zeros/.npmrc", failures: 1, nextRetryAt: iso(hour) } },
      history: [
        { generation: 4, state: "failed", startedAt: iso(-2 * hour), finishedAt: iso(-2 * hour + 300_000), repositories: null, trigger: "manual",
          startedBy: "Alice", failure: { reason: "ready_copy_secret_left", repository: "withso/zeros", step: "secret_search", detail: "/home/user/withso/zeros/.npmrc" }, output: true },
        { generation: 3, state: "ready", startedAt: iso(-3 * day), finishedAt: iso(-3 * day + 120_000),
          repositories: [{ repository: "withso/zeros", branch: "main", commit: "c".repeat(40) }, { repository: "withso/web", branch: "next", commit: "d".repeat(40) }],
          trigger: "repositories_changed", startedBy: null, failure: null, output: false },
      ] });
    expect(text).toContain("Update failed");
    expect(text).toContain("New workspaces still use the build from 3d ago.");
    // One vocabulary: builds, never copies.
    expect(text).not.toMatch(/\bcop(y|ies)\b/i);
    // Why each build ran comes first, after its number.
    expect(container.querySelector('[aria-label="Builds"]')?.textContent).toMatch(/Build #4.*Started by Alice/);
    expect(text).toContain("withso/zeros: A build secret was left on the disk. In /home/user/withso/zeros/.npmrc. Read it from the environment in setup; don't write it to a file.");
    expect(text).toMatch(/Next try in (59|60) minutes/);
    expect(text).toContain("Started by Alice");
    expect(text).toContain("Repositories changed");
    // A project of several repositories names each one's branch and commit.
    expect(text).toContain("withso/zeros main @ ccccccc");
    expect(text).toContain("withso/web next @ ddddddd");
    expect(text).not.toMatch(/ready_copy_/);
    // Output only on the failed build; the successful one stored none.
    expect([...container.querySelectorAll("button")].filter(node => node.textContent === "Output")).toHaveLength(1);
    await act(async () => { button("Output")!.click(); });
    expect(fixture.output).toHaveBeenCalledWith(ORG, expect.stringMatching(/^88888888-/), 4);
    await act(async () => { button("Retry now")!.click(); });
    expect(fixture.build).toHaveBeenCalledOnce();
  });

  it("shows members the status line only", async () => {
    const text = await render({ status: { state: "ready", updatedAt: iso(-day), nextUpdateAt: iso(6 * day) } });
    expect(text).toContain("Ready");
    expect(text).toContain("Updated 1d ago · next update in 6 days");
    expect(button("Build now")).toBeUndefined();
    expect(container.querySelector('[aria-label="Builds"]')).toBeNull();
    expect(await render({ status: { state: "none", updatedAt: null, nextUpdateAt: null } })).toBe("");
  });

  it("names every state", () => {
    const now = Date.now();
    expect(readyCopyStatus({ state: "updating", updatedAt: null, nextUpdateAt: null }, now))
      .toEqual({ label: "Updating…", hint: "New workspaces use the last build until this one is ready." });
    expect(readyCopyStatus({ state: "getting_ready", updatedAt: null, nextUpdateAt: null }, now)?.label).toBe("Getting ready…");
    expect(readyCopyStatus({ state: "failed", updatedAt: null, nextUpdateAt: null }, now)).toMatchObject({ label: "Update failed" });
    expect(readyCopyStatus({ state: "failed", updatedAt: null, nextUpdateAt: null }, now)?.hint).toContain("clone directly");
    expect(readyCopyStatus({ state: "none", updatedAt: null, nextUpdateAt: null }, now)).toBeNull();
  });
});

describe("a project's build status while it is in progress", () => {
  const reads = async () => vi.mocked((await import("../../../platform/cloud-github-levels")).getCloudReadyCopy).mock.calls.length;
  const mount = async (reply: unknown, active = true) => {
    fixture.reply = reply;
    await act(async () => { root.render(createElement(ReadyCopySection, { organizationId: ORG, projectId: `99999999-9999-4999-8999-${String(project++).padStart(12, "0")}`, active })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  };
  const after = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); return container.textContent ?? ""; };
  const building = { canBuild: true, status: { state: "getting_ready", updatedAt: null, nextUpdateAt: null },
    history: [{ generation: 1, state: "building", startedAt: iso(-60_000), finishedAt: null, repositories: null, trigger: "project_created", startedBy: null, failure: null, output: false }] };
  const ready = { canBuild: true, status: { state: "ready", updatedAt: iso(0), nextUpdateAt: iso(7 * day) },
    history: [{ generation: 1, state: "ready", startedAt: iso(-60_000), finishedAt: iso(0), repositories: null, trigger: "project_created", startedBy: null, failure: null, output: false }] };
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked((await import("../../../platform/cloud-github-levels")).getCloudReadyCopy).mockReset().mockImplementation(async () => fixture.reply as never);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("shows Ready on its own once the build finishes, while the page stays open, then stops reading", async () => {
    await mount(building);
    expect(container.textContent).toContain("Getting ready…");
    fixture.reply = ready;
    expect(await after(10_000)).toContain("Ready");
    expect(container.textContent).not.toContain("Getting ready…");
    const settled = await reads();
    await after(120_000);
    expect(await reads()).toBe(settled);
  });

  it("keeps the last status on screen while it reads again", async () => {
    await mount(building);
    let release!: () => void;
    const { getCloudReadyCopy } = await import("../../../platform/cloud-github-levels");
    vi.mocked(getCloudReadyCopy).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(ready as never); }));
    expect(await after(10_000)).toContain("Getting ready…");
    release();
    expect(await after(0)).toContain("Ready");
  });

  it("reads again while the organization's Cloud Computer is being prepared", async () => {
    await mount({ canBuild: true, status: { state: "none", updatedAt: null, nextUpdateAt: null }, history: [], base: { state: "preparing" } });
    expect(container.textContent).toContain("Preparing the Cloud Computer…");
    fixture.reply = building;
    expect(await after(10_000)).toContain("Getting ready…");
  });

  it("never reads again while the page is not the active one", async () => {
    await mount(building, false);
    const before = await reads();
    await after(60_000);
    expect(await reads()).toBe(before);
  });
});
