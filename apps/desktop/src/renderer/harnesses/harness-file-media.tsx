// Browser-only fixture around the real FileViewer, read cache and bridge facade.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { Profiler } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { TooltipProvider } from "../shared/ui/primitives/tooltip";
import { Toaster } from "../shared/ui/primitives/elements";
import { FileViewer } from "../shell/workbench/tabs/file-viewer";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { ReadFileResult } from "../platform/files";
import {
  invalidateWorkspaceFileData,
  primeWorkspaceFileRead,
} from "../shell/workspace-file-data-cache";
import { FILE_MEDIA_VIDEO } from "./harness-file-media-fixtures";

const owners = {
  personal: "/media-personal",
  organization: "/media-organization",
  cloud:
    "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222",
};
type Owner = keyof typeof owners;
const requests: { op: string; params: Record<string, unknown> }[] = [];
const pending: { key: string; finish: () => void }[] = [];
const held = new Set<string>();
const images = new Map<string, string>();
function image(owner: string) {
  let source = images.get(owner);
  if (source) return source;
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 800;
  const context = canvas.getContext("2d")!;
  const styles = getComputedStyle(document.documentElement);
  const color = (token: string) => styles.getPropertyValue(token).trim();
  context.fillStyle = color(
    owner === owners.cloud
      ? "--green-bg"
      : owner === owners.organization
        ? "--purple-bg"
        : "--blue-bg",
  );
  context.fillRect(0, 0, 1200, 800);
  context.strokeStyle = color("--blue-primary");
  context.lineWidth = 2;
  for (let x = 0; x <= 1200; x += 80) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, 800);
    context.stroke();
  }
  for (let y = 0; y <= 800; y += 80) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(1200, y);
    context.stroke();
  }
  context.fillStyle = color("--bg2");
  context.fillRect(160, 180, 880, 440);
  context.fillStyle = color("--fg1");
  context.font = "56px sans-serif";
  context.fillText("Image preview", 245, 315);
  context.font = "28px sans-serif";
  context.fillText("Zoom, drag, copy and download", 245, 380);
  context.fillStyle = color("--red-primary");
  context.fillRect(245, 440, 80, 80);
  context.fillStyle = color("--green-primary");
  context.beginPath();
  context.arc(400, 480, 40, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = color("--blue-primary");
  context.fillRect(475, 440, 150, 80);
  source = canvas.toDataURL("image/png");
  canvas.width = canvas.height = 0;
  images.set(owner, source);
  return source;
}
let videoSource = FILE_MEDIA_VIDEO;
let revision = 0,
  commits = 0;
const fixtureResult = (cwd: string, path: string): ReadFileResult =>
  path.endsWith(".webm")
    ? { kind: "video", path, bytes: 1000, dataUrl: videoSource }
    : path.endsWith(".txt")
      ? { kind: "text", path, bytes: 4, content: "text" }
      : path.endsWith(".svg")
        ? {
            kind: "image",
            path,
            bytes: 100,
            dataUrl: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="120"><rect width="180" height="120" fill="tomato"/></svg>')}`,
          }
        : {
            kind: "image",
            path,
            bytes: 1000,
            dataUrl:
              path === "broken.png" ? "data:image/png;base64,AA==" : image(cwd),
          };

setActiveBridge({
  status: "connected",
  on: () => () => {},
  onStatusChange: () => () => {},
  request: async (message: {
    op?: string;
    params?: Record<string, unknown>;
  }) => {
    const op = message.op ?? "",
      params = message.params ?? {};
    requests.push({ op, params });
    let result: unknown = {};
    if (op === "file.read") {
      const cwd = String(params.workspaceId),
        path = String(params.path);
      result = fixtureResult(cwd, path);
      const key = `${cwd}:${path}`;
      if (held.has(key))
        await new Promise<void>((resolve) =>
          pending.push({ key, finish: resolve }),
        );
    } else if (op === "workspace.list") result = [];
    return { type: "WORKSPACE_RESPONSE", result };
  },
} as never);
const root = createRoot(document.getElementById("root")!);
const harness = {
  owners,
  requests,
  get commits() {
    return commits;
  },
  render(owner: Owner = "personal", path = "sample.png", active = true) {
    flushSync(() =>
      root.render(
        <TooltipProvider>
          <Profiler
            id="media"
            onRender={() => {
              commits += 1;
            }}
          >
            <main
              className="bg-bg1 text-fg1 h-screen w-full"
              style={{ visibility: active ? "visible" : "hidden" }}
              {...(!active ? { inert: "" } : {})}
            >
              <FileViewer
                tabId="media-file"
                cwd={owners[owner]}
                path={path}
                active={active}
                refreshKey={revision}
                headerBorder
              />
            </main>
          </Profiler>
          <Toaster />
        </TooltipProvider>,
      ),
    );
  },
  source: (owner: Owner = "personal") => image(owners[owner]),
  video(source: string) {
    videoSource = source;
  },
  videoSource: () => videoSource,
  prime(owner: Owner, path: string) {
    primeWorkspaceFileRead(
      { cwd: owners[owner], path },
      fixtureResult(owners[owner], path),
    );
  },
  invalidate(owner: Owner) {
    revision += 1;
    invalidateWorkspaceFileData(owners[owner]);
  },
  hold(owner: Owner, path: string) {
    held.add(`${owners[owner]}:${path}`);
  },
  release() {
    held.clear();
    for (const item of pending.splice(0)) item.finish();
  },
};
declare global {
  interface Window {
    __zerosFileMediaHarness: typeof harness;
  }
}
window.__zerosFileMediaHarness = harness;
harness.render();
