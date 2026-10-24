// Production rows and file-pill navigation; only native I/O is a fixture.
import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { AgentToolMessage } from "@zeros/protocol/agent-messages";
import { EventRowRenderer } from "../features/agent/renderers/event-row-renderer";
import type { RendererContext } from "../features/agent/renderers/types";
import { Button, TooltipProvider } from "../shared/ui/primitives";
import { WorkspaceRuntimeClient } from "../platform/bridge/workspace-runtime-client";
import { setActiveBridge } from "../platform/bridge/active-bridge";
import type { BridgeMessage } from "../platform/bridge/messages";
import { relativeWorkspaceFilePath } from "../platform/workspace-file-path";
import { useWorkspaceStore } from "../state/workspace-store";
import { defaultScopeFor } from "../shell/workbench/tab-model";
import { openFilePill } from "../shell/workbench/file-pill-navigation";

const owners = {
  Local: { cwd: "/personal/project", root: "/personal/project" },
  Organization: { cwd: "/organization/project", root: "/organization/project" },
  Cloud: { cwd: "cloud://11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222", root: "/home/user/example/project" },
};
type Owner = keyof typeof owners;
const workspaces = Object.values(owners).map(({ cwd }) => ({ id: cwd, path: cwd, repoRoot: cwd, repoSlug: "image-fixture" }));
const requests: unknown[] = [];

function imageData() {
  // Synthetic image content, not application chrome; Canvas owns these colors.
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const drawing = canvas.getContext("2d")!;
  const sky = drawing.createLinearGradient(0, 0, 0, 150);
  sky.addColorStop(0, "midnightblue");
  sky.addColorStop(0.65, "coral");
  sky.addColorStop(1, "gold");
  drawing.fillStyle = sky;
  drawing.fillRect(0, 0, 320, 180);
  drawing.fillStyle = "lightgoldenrodyellow";
  drawing.beginPath();
  drawing.arc(220, 94, 24, 0, Math.PI * 2);
  drawing.fill();
  drawing.fillStyle = "slateblue";
  drawing.fillRect(0, 118, 320, 62);
  drawing.fillStyle = "sandybrown";
  drawing.beginPath();
  drawing.moveTo(0, 160);
  drawing.quadraticCurveTo(140, 126, 320, 171);
  drawing.lineTo(320, 180);
  drawing.lineTo(0, 180);
  drawing.fill();
  return canvas.toDataURL("image/png").split(",")[1];
}
const png = imageData();

class FixtureBridge extends WorkspaceRuntimeClient {
  constructor() { super({ open: async () => { throw new Error("Unexpected VM wake"); }, workspaces: () => workspaces }); }
  override get status() { return "connected" as const; }
  override fileReferencePath(cwd: string, path: string) {
    const owner = Object.values(owners).find((entry) => entry.cwd === cwd);
    return relativeWorkspaceFilePath(cwd, path, owner?.root);
  }
  override async request<T extends BridgeMessage = BridgeMessage>(message: Partial<BridgeMessage> & { type: string }): Promise<T> {
    requests.push(message);
    return { type: "WORKSPACE_RESPONSE", result: { kind: "image", path: "beach.jpg", bytes: png.length, dataUrl: `data:image/png;base64,${png}` } } as unknown as T;
  }
}
setActiveBridge(new FixtureBridge());
useWorkspaceStore.setState({ workbenchByScope: Object.fromEntries(Object.values(owners).map(({ cwd }) => [cwd, defaultScopeFor(cwd)])) });
Object.assign(window, { __generatedImages: {
  requests: () => requests,
  workbenches: () => useWorkspaceStore.getState().workbenchByScope,
} });

function Fixture() {
  const [owner, setOwner] = useState<Owner>("Local");
  const [active, setActive] = useState(true);
  const [broken, setBroken] = useState(true);
  const { cwd, root } = owners[owner];
  const ctx = { attachmentCwd: cwd, attachmentImagesActive: active, editBaselines: new Map(),
    openFile: (path: string) => openFilePill(cwd, path),
  } as RendererContext;
  const rows = [
    ["generation", "sunset-poster.png"], ["edit", "sunset-edit.png"],
    ["placeholder", "saved-by-codex.png"], ["legacy", "legacy-inline.png"], ["broken", "broken-native.png"],
  ] as const;
  return <TooltipProvider>
    <main data-zeros-root="" className="min-h-screen bg-bg1 p-6 text-fg1">
      <div className="mb-4 flex flex-wrap gap-2">
        {(Object.keys(owners) as Owner[]).map((name) => <Button key={name} onClick={() => setOwner(name)} aria-pressed={owner === name}>{name}</Button>)}
        <Button onClick={() => setActive(!active)}>{active ? "Hide media" : "Show media"}</Button>
        <Button onClick={() => setBroken(false)}>Repair preview</Button>
      </div>
      <div className="max-w-2xl space-y-4" data-image-owner={owner}>
        {rows.map(([kind, filename]) => {
          const message: AgentToolMessage = { kind: "tool", id: `${owner}-${kind}`, toolCallId: `${owner}-${kind}`,
            nativeToolCallId: `${owner}-${kind}`, title: "Generating image", toolKind: "other", status: "completed", createdAt: 1, updatedAt: 2,
            rawOutput: { status: "completed", failure: null, savedPath: `${root}/${filename}`,
              ...(kind === "edit" ? { inputImages: [{ path: `${root}/beach.jpg`, sha256: "a".repeat(64) }] } : {}),
            },
            content: kind === "placeholder" ? [{ type: "content", content: { type: "text", text: "Image saved by Codex" } }]
              : [{ type: "content", content: { type: "image", mimeType: "image/png", data: kind === "broken" && broken ? "AAAA" : png } }],
          };
          return <article key={`${owner}-${kind}`} data-generated-image-case={kind} className="bg-bg1 p-3">
            <EventRowRenderer message={message} ctx={ctx} />
          </article>;
        })}
      </div>
    </main>
  </TooltipProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
