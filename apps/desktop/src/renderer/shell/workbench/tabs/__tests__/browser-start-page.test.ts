import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CLOUD_SCOPE = `cloud://${ORG}/${WORKSPACE}`;

const fixture = vi.hoisted(() => ({
  invoke: vi.fn(),
  previewAvailable: true,
  doc: undefined as unknown,
  detected: { data: undefined as unknown, error: null as Error | null },
  detectedCalls: [] as Array<[string | null, { active: boolean; open: boolean; featureActive: boolean }]>,
}));

vi.mock("../../../../platform/runtime", () => ({
  nativeInvoke: fixture.invoke,
  useNativeRuntime: () => ({ ready: true }),
}));
vi.mock("../../../../platform/cloud-workspace-access", () => ({
  workspacePreviewAvailable: (scope: string) => !scope.startsWith("cloud://") || fixture.previewAvailable,
}));
vi.mock("../../../../state/cloud-workspace-catalog", () => ({
  cloudWorkspaceDocument: () => fixture.doc,
  subscribeCloudWorkspaces: () => () => {},
}));
vi.mock("../../../../state/use-cloud-workspace-detected-ports", () => ({
  useCloudWorkspaceDetectedPorts: (
    folder: string | null,
    options: { active: boolean; open: boolean; featureActive: boolean },
  ) => {
    fixture.detectedCalls.push([folder, options]);
    return fixture.detected;
  },
}));
vi.mock("../../../../features/browser/local-workspace-folders", () => ({
  registeredLocalWorkspaceFolders: () => ["/work/web", "/work/web/.claude/worktrees/x", "/work/api"],
}));
vi.mock("../../../../features/browser/local-dev-servers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../features/browser/local-dev-servers")>();
  return { ...actual, useLocalDevServers: vi.fn(actual.useLocalDevServers) };
});

import { useLocalDevServers, localDevServers } from "../../../../features/browser/local-dev-servers";
import { BrowserStartPage, cloudPortsNotice, localRowDetail } from "../browser-start-page";
import type { CloudWorkspaceDocument } from "../../../../platform/cloud-workspaces";

function doc(status: string, overrides: Partial<CloudWorkspaceDocument> = {}) {
  return {
    id: WORKSPACE,
    organizationId: ORG,
    status,
    deletedAt: null,
    capabilities: { canWrite: true, canEdit: true, canManage: true, canStart: true, startUnavailableReason: null },
    generation: { number: 3 },
    ...overrides,
  } as unknown as CloudWorkspaceDocument;
}

const render = (scope: string, active = true) =>
  renderToStaticMarkup(React.createElement(BrowserStartPage, { scope, active, onOpen: () => {} }));

beforeEach(() => {
  vi.mocked(useLocalDevServers).mockClear();
  fixture.invoke.mockReset();
  fixture.previewAvailable = true;
  fixture.doc = doc("ready");
  fixture.detected = { data: undefined, error: null };
  fixture.detectedCalls = [];
});

describe("BrowserStartPage local placement", () => {
  it("renders only the workspace's servers from the shared store and never reads cloud ports", async () => {
    fixture.invoke.mockResolvedValue({
      root: "/work/web",
      servers: [
        { port: 5173, url: "http://localhost:5173", title: "Vite App", processName: "node", cwd: "/work/web" },
        { port: 6006, url: "http://localhost:6006", cwd: "/work/web/apps/docs" },
      ],
    });
    await localDevServers.refresh("/work/web", { force: true });
    expect(fixture.invoke).toHaveBeenCalledWith("browser:list-local-servers", {
      root: "/work/web",
      exclude: ["/work/web/.claude/worktrees/x"],
    });
    const html = render("/work/web");
    expect(html).toContain("Open a site or preview your app");
    expect(html).not.toContain("Enter any http(s) URL");
    expect(html).toContain("Local");
    expect(html).toContain("Vite App");
    expect(html).toContain("localhost:5173 · node");
    expect(html).toContain("localhost:6006 · apps/docs");
    expect(html).toContain("Running");
    expect(html).toContain('aria-label="Local server options"');
    expect(vi.mocked(useLocalDevServers)).toHaveBeenCalledWith({ scope: "/work/web", active: true });
    expect(fixture.detectedCalls).toEqual([]);
  });

  it("keeps another workspace's servers out of this workspace", async () => {
    fixture.invoke.mockResolvedValue({
      root: "/work/api",
      servers: [{ port: 4000, url: "http://localhost:4000", title: "API docs", cwd: "/work/api" }],
    });
    await localDevServers.refresh("/work/api", { force: true });
    expect(render("/work/api")).toContain("API docs");
    expect(render("/work/web")).not.toContain("API docs");
  });

  it("shows a neutral line and never probes without a workspace folder", () => {
    const html = render("__ambient__");
    expect(html).toContain("Open a workspace to see its local servers.");
    expect(html).not.toContain("Local server options");
    expect(fixture.invoke).not.toHaveBeenCalled();
  });

  it("describes rows with their subfolder or process", () => {
    const base = { port: 3000, url: "http://localhost:3000", lastSeenAt: 1, status: "online" as const };
    expect(localRowDetail(base, "/a/b")).toBe("localhost:3000");
    expect(localRowDetail({ ...base, processName: "node" }, "/a/b")).toBe("localhost:3000 · node");
    expect(localRowDetail({ ...base, processName: "node", cwd: "/a/b" }, "/a/b/")).toBe("localhost:3000 · node");
    expect(localRowDetail({ ...base, processName: "node", cwd: "/a/b/site/web" }, "/a/b")).toBe(
      "localhost:3000 · site/web",
    );
    expect(localRowDetail({ ...base, processName: "node", cwd: "/a/bc" }, "/a/b")).toBe("localhost:3000 · node");
    expect(localRowDetail({ ...base, cwd: "/a/b/site" }, null)).toBe("localhost:3000");
  });
});

describe("BrowserStartPage cloud placement", () => {
  it("never mounts or invokes the local probe for a cloud scope", () => {
    fixture.detected = {
      data: {
        organizationId: ORG,
        workspaceId: WORKSPACE,
        ports: [
          { port: 3000, processLabel: "node", health: "healthy" },
          { port: 4000, processLabel: null, health: "closed" },
          { port: 8080, processLabel: null, health: "unhealthy" },
        ],
      },
      error: null,
    };
    const html = render(CLOUD_SCOPE);
    expect(vi.mocked(useLocalDevServers)).not.toHaveBeenCalled();
    expect(fixture.invoke).not.toHaveBeenCalled();
    expect(html).not.toContain("Local server options");
    expect(html).toContain("Port 3000");
    expect(html).toContain("localhost:3000 · node");
    expect(html).toContain("Not responding");
    expect(html).not.toContain("Port 4000");
    expect(fixture.detectedCalls).toEqual([[CLOUD_SCOPE, { active: true, open: true, featureActive: true }]]);
  });

  it("ignores a late port snapshot for another workspace", () => {
    fixture.detected = {
      data: { organizationId: ORG, workspaceId: OTHER, ports: [{ port: 3000, processLabel: null, health: "healthy" }] },
      error: null,
    };
    const html = render(CLOUD_SCOPE);
    expect(html).not.toContain("Port 3000");
    expect(html).toContain("Checking workspace ports");
  });

  it("renders a neutral line for each non-running VM state without enabling the read", () => {
    const cases: Array<[string, string]> = [
      ["setting_up", "finishes setting up"],
      ["starting", "has started"],
      ["sleeping", "Start the workspace to see its ports."],
      ["stopped", "Start the workspace to see its ports."],
      ["stopping", "The workspace is stopping."],
      ["failed", "until the workspace recovers"],
      ["archived", "This workspace is archived."],
    ];
    for (const [status, copy] of cases) {
      fixture.doc = doc(status);
      fixture.detectedCalls = [];
      expect(render(CLOUD_SCOPE)).toContain(copy);
      expect(fixture.detectedCalls.at(-1)?.[1].featureActive).toBe(false);
    }
    expect(cloudPortsNotice(undefined)).toBe("Ports appear when the workspace is ready.");
    expect(cloudPortsNotice(doc("ready", { capabilities: { canWrite: true, canManage: false, canStart: true, startUnavailableReason: null } }))).toContain("Editing access");
    expect(vi.mocked(useLocalDevServers)).not.toHaveBeenCalled();
  });

  it("keeps the preview-unavailable copy and skips ports when cloud previews are off", () => {
    fixture.previewAvailable = false;
    const html = render(CLOUD_SCOPE);
    expect(html).toContain("Cloud preview URLs are not configured for this build.");
    expect(fixture.detectedCalls).toEqual([]);
  });

  it("passes inactive state through so hidden tabs stay inert", () => {
    render(CLOUD_SCOPE, false);
    expect(fixture.detectedCalls[0]?.[1].active).toBe(false);
  });
});
