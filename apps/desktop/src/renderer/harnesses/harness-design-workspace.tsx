// Standalone development harness — NOT part of the shipped app.
//
// Serves the real DesignWorkspaceColumn — the full-bleed canvas with its
// floating directory pill, tool rail, and Layers + Inspector panel — with a
// warm aggregate snapshot so browser QA can inspect layout and local
// interactions without an Electron preload or engine. An in-memory bridge
// persists fixture mutations while rendering, selection, and editing use the
// production components.

import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import {
  DESIGN_RUNTIME_SOURCE,
  DESIGN_RUNTIME_DOCUMENT_BODY_ID,
} from "@zeros/protocol/design-runtime";
import { designFrameGeometryError } from "@zeros/design-core";
import { mutateDesignNodeDuplicateSource, mutateDesignNodeDeleteSource } from "@zeros/design-web/html";
import {
  mutateDesignKeyframes,
  readDesignKeyframes,
  type DesignKeyframeInput,
} from "@zeros/design-web/css";
import { designRelocationSchema, designRelocationStyles } from "@zeros/protocol/design-relocation";
import type {
  DesignFoundationOpenWire,
  DesignWorkspaceSnapshotWire,
} from "../platform/git";
import { createDesignPagesHarness } from "./harness-design-pages";
import { LAYERED_LAYOUT_SOURCE } from "./harness-design-layered-layout";

// Opt-in continuity measurements use the same lazy engine boundary, with
// request latency instead of a manually released preparation barrier.
const measureManipulationHarness = new URLSearchParams(window.location.search).has("measureManipulation");
const measureContinuityHarness = measureManipulationHarness || new URLSearchParams(window.location.search).has("measureContinuity");
const profileContinuityHarness = measureContinuityHarness && new URLSearchParams(window.location.search).has("profileContinuity");
const attributeContinuityHarness = profileContinuityHarness && new URLSearchParams(window.location.search).has("attributeContinuity");
const retainedContinuityHarness = measureContinuityHarness && new URLSearchParams(window.location.search).has("retainedContinuity");
const profilerCommits: Array<{ id: string; phase: string; actualDuration: number; baseDuration: number; startTime: number; commitTime: number }> = [];
const requestedEngineDelay = Number(new URLSearchParams(window.location.search).get("engineDelayMs") ?? 400);
const engineDelayMs = measureContinuityHarness
  ? Math.max(0, Math.min(500, Number.isFinite(requestedEngineDelay) ? requestedEngineDelay : 400)) : 0;
const delayedOperations = new Set(["design.frames.prepare", "design.navigation.read", "design.frame.create", "design.transaction.apply", "design.node.styles"]);
if (measureManipulationHarness)
  for (const operation of ["design.canvas.update", "design.frames.move", "design.frame.duplicate", "design.node.transfer", "design.history.undo", "design.history.redo"])
    delayedOperations.add(operation);
const delayedRequests: Array<{ op: string; workspaceId: string; started: number; released: number | null }> = [];
const measurementHolds = new Map<string, { promise: Promise<void>; release(): void }>();
const scopedMutationsHarness = new URLSearchParams(window.location.search).has("scopedMutations");
const lazyPreparationHarness = scopedMutationsHarness || measureContinuityHarness || new URLSearchParams(window.location.search).has("lazyPreparation");
const HOME_SOURCE_VERSION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PRICING_SOURCE_VERSION = "bbbbbbbbbbbbbbbbbbbbbbbb";
const HARNESS_LAYER_COUNT = new URLSearchParams(window.location.search).has(
  "denseLayers",
)
  ? 10_000
  : 48;

// `?styleSources=1` adds imported style sources; the default harness keeps
// the snapshot shape every existing smoke check was written against.
const styleSourcesHarness = new URLSearchParams(window.location.search).has(
  "styleSources",
);
const HARNESS_STYLE_SOURCES: DesignWorkspaceSnapshotWire["styleSources"] = [
  {
    id: "app",
    title: "App tokens",
    kind: "css",
    path: "src/styles/tokens.css",
    status: "warning",
    messages: [
      { level: "info", text: "Skipped 2 build-tool directives (@tailwind, @source, @plugin, @apply, …); only plain CSS is imported." },
      { level: "warning", text: 'Theme "dark": no rule uses the selector .dark.' },
    ],
    themes: ["dark", "light"],
    tokens: [
      { name: "--surface", value: "white", themeValues: { light: "whitesmoke" } },
      { name: "--radius-card", value: "8px", themeValues: {} },
    ],
    bytes: 120,
    revision: "style-source-revision-1",
  },
  {
    id: "brand",
    title: "Brand kit",
    kind: "css",
    path: "packages/brand/brand.css",
    status: "error",
    messages: [{ level: "error", text: "packages/brand/brand.css is missing, outside the repository, a symlink, or larger than 2 MiB." }],
    themes: [],
    tokens: [],
    bytes: 0,
    revision: null,
  },
];

function withDesignRuntime(source: string, sourceVersion: string): string {
  const runtime =
    `<script>window.__zerosDesignSourceVersion=${JSON.stringify(sourceVersion)};` +
    `${DESIGN_RUNTIME_SOURCE}</script>`;
  return source.replace(/<\/body>/i, () => `${runtime}</body>`);
}

const layoutGestureHarness = new URLSearchParams(window.location.search).has(
  "layoutGestures",
);
const frameMotionHarness = new URLSearchParams(window.location.search).has(
  "frameMotion",
);
const framePlaybackHarness = new URLSearchParams(window.location.search).has("framePlayback");
// `?designTokens`: the home frame is styled by an imported source and the
// linked tokens.css, as a composed document carries them, so the inspector
// can name tokens and their sources.
const designTokensHarness = new URLSearchParams(window.location.search).has(
  "designTokens",
);
const DESIGN_TOKENS_HOME_SOURCE = `<!doctype html>
<html>
  <head>
    <style data-zeros-layer-order="">@layer reset;</style>
    <style data-zeros-style-source="app">
      @layer theme, utilities;
      @layer theme { :root { --primary-button-bg: darkslategray; --primary-button-fg: white; } }
      @layer utilities {
        .bg-primary-button-bg { background-color: var(--primary-button-bg); }
        .text-primary-button-fg { color: var(--primary-button-fg); }
      }
    </style>
    <style data-zeros-source="tokens.css">
      :root { --brand: rebeccapurple; }
      .title { color: var(--brand); }
    </style>
    <style>body { margin: 0; } main { padding: 72px; } button { border: 0; padding: 8px 12px; }</style>
  </head>
  <body>
    <main data-oid="home-main" data-zeros-frame-root>
      <h1 data-oid="home-heading" class="title">Make the next move unmistakable.</h1>
      <div data-oid="home-cta" class="bg-primary-button-bg">
        <button data-oid="home-button" class="text-primary-button-fg">Save</button>
      </div>
    </main>
  </body>
</html>`;
// A frame serialized from a web component: its visible content renders from
// a declarative shadow root, and a class rule authors properties no dedicated
// Style control shows (Advanced) beside a universal reset (hidden there).
const SHADOW_CONTENT_HOME_SOURCE = `<!doctype html><html><head><style>
  * { box-sizing: border-box; margin: 0; }
  body { font-family: system-ui; background: white; }
  .card { cursor: pointer; user-select: none; --card-gap: 12px; padding: 16px; }
</style></head><body><main data-oid="home-main" data-zeros-frame-root style="display:block;padding:40px">
  <div data-oid="home-card" class="card" style="display:block;width:320px;background:white">
    <diffs-container data-oid="home-diff" style="display:block;width:300px;background:firebrick">
      <template shadowrootmode="open"><style>pre { margin: 0; padding: 12px; background: black; color: gainsboro; font: 12px ui-monospace; }</style><pre data-oid="home-diff-pre"><span data-oid="home-diff-line">const value = 1;</span></pre></template>
    </diffs-container>
  </div>
</main></body></html>`;
const homeSource = designTokensHarness
  ? DESIGN_TOKENS_HOME_SOURCE
  : new URLSearchParams(window.location.search).has("shadowContent")
  ? SHADOW_CONTENT_HOME_SOURCE
  : new URLSearchParams(window.location.search).has("layeredLayout")
  ? LAYERED_LAYOUT_SOURCE
  : new URLSearchParams(window.location.search).has("mixedParents")
  ? `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}</style></head><body><main data-oid="home-main" data-zeros-frame-root style="position:relative;display:block;width:100%;height:100vh;background:white"><div data-oid="home-hero" style="position:absolute;left:80px;top:80px;width:200px;height:200px;transform:scale(2,1.5);transform-origin:0 0"><div data-oid="home-heading" style="position:absolute;left:20px;top:20px;width:80px;height:60px;background:red"></div></div><div data-oid="home-panel" style="position:absolute;left:640px;top:80px;width:200px;height:200px;transform:scale(-1,1)"><div data-oid="home-copy" style="position:absolute;left:20px;top:20px;width:80px;height:60px;background:blue"></div></div></main></body></html>`
  : new URLSearchParams(window.location.search).has("freeRelocation")
  ? `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;font-family:system-ui}</style></head><body><main data-oid="home-main" data-zeros-frame-root style="position:relative;display:block;width:100%;height:100vh;background:white;color:navy;font-size:30px;--accent:red"><div data-oid="home-hero" style="position:absolute;left:80px;top:80px;width:120px;height:80px;margin:5px 7px 9px 20px;transform:matrix(1,0.2,0.25,1,0,0);background:var(--accent)"><span data-oid="home-heading">Move</span></div></main></body></html>`
  : new URLSearchParams(window.location.search).has("nestedOffsets")
  ? // Two frames nested by an older build: each placed by a translate beside
    // its box at 0, 0 (the relocation encoding before left/top placement).
    `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:white;font-family:system-ui}</style></head><body><main data-oid="home-main" data-zeros-frame-root style="display:block;min-height:100vh;padding:40px"><div data-oid="home-hero" style="position:relative;display:block;width:390px;height:654px;padding:0;background:indianred">${[["home-heading", 223], ["home-copy", 302]].map(([oid, y]) => `<div data-oid="${oid}" style="position:absolute;inset:0 auto auto 0;left:0px;top:0px;margin:0;width:259px;height:59px;box-sizing:border-box;min-width:0;min-height:0;max-width:none;max-height:none;transform:matrix(1,0,0,1,66,${y});transform-origin:0 0;rotate:none;scale:none;translate:none;background:white"></div>`).join("")}</div></main></body></html>`
  : new URLSearchParams(window.location.search).has("autoLayout")
  ? `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0;background:white;color:black;font-family:system-ui}</style></head><body><main data-oid="home-main" data-zeros-frame-root style="display:block;min-height:100vh;padding:72px"><div data-oid="home-hero" style="position:relative;display:block;width:300px;height:240px;max-width:none;padding:0;box-sizing:border-box">${["h1", "p", "span"].map((tag, index) => `<${tag} data-oid="${["home-heading", "home-copy", "home-action"][index]}" style="position:absolute;left:${16 + index * 90}px;top:20px;width:80px;height:40px;min-width:0;max-width:none;margin:0;padding:0;box-sizing:border-box;font-size:12px">${["Heading", "Copy", "Action"][index]}</${tag}>`).join("")}</div></main></body></html>`
  : layoutGestureHarness
  ? `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0} [data-oid]{margin:0}</style></head><body><main data-oid="home-main" data-zeros-frame-root style="position:relative;display:block;width:100%;height:100vh;background:white"><div data-oid="home-hero" style="position:absolute;left:80px;top:80px;display:flex;width:600px;height:300px;gap:20px;padding:20px;align-items:flex-start"><div data-oid="home-heading" style="width:100px;height:80px;flex-shrink:0;background:red"></div><div data-oid="home-copy" style="width:100px;height:80px;flex-shrink:0;background:blue"></div><div data-oid="home-action" style="width:100px;height:80px;flex-shrink:0;background:green"></div></div></main></body></html>`
  : new URLSearchParams(window.location.search).has("authoredFrame")
    ? `<!doctype html><html><head><style>* { box-sizing:border-box; }</style></head>
    <body style="margin:0;display:block;position:relative;height:100vh;background:white">
      <main data-oid="home-main" style="display:block;position:absolute;left:0;top:400px;width:100%;height:64px;background:red;rotate:180deg">
        <div data-oid="red-child" style="display:block;position:absolute;left:40px;top:10px;width:100px;height:30px"></div>
      </main>
    </body></html>`
    : new URLSearchParams(window.location.search).has("emptyFrame")
      ? `<!doctype html><html><head><style>
      * { box-sizing:border-box; }
      body { margin:0; background:white; }
      body [data-oid] { display:block; position:relative; margin:0; }
    </style></head><body><main data-oid="home-main" data-zeros-frame-root style="display:block;position:relative;height:100vh;"></main></body></html>`
      : `<!doctype html>
<html data-oid="home-html">
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: white; color: black; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between; padding: 72px; }
      nav { display: flex; align-items: center; justify-content: space-between; }
      .mark { margin-left: 2px; font-weight: 700; letter-spacing: -0.04em; }
      .hero { display: flex; max-width: 900px; flex-direction: column; gap: 24px; }
      h1 { margin: 0; font-size: 88px; line-height: 0.95; letter-spacing: -0.06em; }
      p { max-width: 620px; margin: 0; color: dimgray; font-size: 24px; line-height: 1.5; }
      .button { width: fit-content; border-radius: 999px; background: black; color: white; padding: 16px 24px; }
      .harness-layer { display: none; }
      ${framePlaybackHarness ? `
      .playback-controls { display: flex; align-items: center; gap: 32px; font-size: 20px; }
      .playback-hover { padding: 16px 24px; border: 1px solid; border-radius: 0; transition: border-radius .2s; }
      .playback-hover:hover { border-radius: 24px; }
      ` : ""}
      ${frameMotionHarness ? `
      main { animation: wash 18s linear infinite; }
      @keyframes wash { from { opacity: 0.6; } to { opacity: 1; } }
      ` : ""}
    </style>
  </head>
  <body data-oid="home-body">
    <main data-oid="home-main" data-zeros-frame-root>
      <nav data-oid="home-nav"><span data-oid="home-mark" class="mark">NORTH/ONE</span><span data-oid="home-season">Summer 2026</span></nav>
      <div data-oid="home-hero" class="hero" ${new URLSearchParams(location.search).has("layerNames") ? 'data-name="Hero content"' : ""}>
        <h1 data-oid="home-heading" ${new URLSearchParams(location.search).has("layerNames") ? 'data-name="Hero heading" aria-label="Accessible heading" id="hero-title"' : ""}>Make the next move unmistakable.</h1>
        <p data-oid="home-copy">A decisive launch surface for teams building products that deserve attention.</p>
        <span data-oid="home-action" class="button">Explore the system →</span>
        ${framePlaybackHarness ? `<div class="playback-controls"><label><input type="checkbox">Try this control</label><button class="playback-hover">Hover preview</button></div>` : ""}
        ${Array.from(
          { length: HARNESS_LAYER_COUNT },
          (_, index) =>
            `<span data-oid="home-layer-${index + 1}" class="harness-layer">Layer ${index + 1}</span>`,
        ).join("")}
      </div>
      <span data-oid="home-services">Strategy · Identity · Product</span>
    </main>
  </body>
</html>`;

const pricingSource = `<!doctype html>
<html data-oid="pricing-html">
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: black; color: white; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100vh; display: flex; flex-direction: column; gap: 48px; padding: 72px; }
      header { display: flex; align-items: end; justify-content: space-between; }
      h1 { max-width: 760px; margin: 0; font-size: 76px; line-height: 1; letter-spacing: -0.05em; }
      .plans { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
      article { min-height: 420px; display: flex; flex-direction: column; justify-content: space-between; border: 1px solid dimgray; border-radius: 16px; padding: 32px; }
      article:nth-child(2) { background: royalblue; border-color: royalblue; }
      /* Font-independent: at the default 25% zoom a "normal" line box is only
         9-11 screen pixels, so a selected name's 4px top and bottom resize
         strips could cover its center. */
      strong { font-size: 32px; line-height: 1.5; }
      p { color: lightgray; line-height: 1.5; }
    </style>
  </head>
  <body data-oid="pricing-body">
    <main data-oid="pricing-main" data-zeros-frame-root>
      <header data-oid="pricing-header"><h1 data-oid="pricing-heading">Simple plans for serious momentum.</h1><span data-oid="pricing-cancel">Cancel anytime</span></header>
      <div data-oid="pricing-plans" class="plans">
        <article data-oid="pricing-start"><strong data-oid="pricing-start-name">Start</strong><p data-oid="pricing-start-copy">For one focused product team.</p><b data-oid="pricing-start-price">$24</b></article>
        <article data-oid="pricing-scale"><strong data-oid="pricing-scale-name">Scale</strong><p data-oid="pricing-scale-copy">For companies ready to compound.</p><b data-oid="pricing-scale-price">$79</b></article>
        <article data-oid="pricing-custom"><strong data-oid="pricing-custom-name">Custom</strong><p data-oid="pricing-custom-copy">For ambitious operating systems.</p><b data-oid="pricing-custom-price">Let’s talk</b></article>
      </div>
    </main>
  </body>
</html>`;

async function main() {
  if (new URLSearchParams(location.search).has("motionOwner")) {
    const { mountDesignMotionOwnerHarness } = await import("./harness-design-motion-owner");
    mountDesignMotionOwnerHarness();
    return;
  }
  const workbenchHarness = new URLSearchParams(location.search).has("workbench");
  const selectionReferencesHarness = new URLSearchParams(location.search).has("selectionReferences");
  // Saved frame pictures are keyed by their Design directory.
  const picturesHarness = new URLSearchParams(location.search).has("pictures");
  const pagesHarness = new URLSearchParams(location.search).has("pages");
  const workspaceId = pagesHarness ? "ws_design_pages_harness" : "ws_design_harness";
  const workspacePath =
    "/Users/demo/zeros/design workspaces/north-one/launch-system";
  const workspace = {
    id: workspaceId,
    kind: "design" as const,
    repoSlug: "north-one",
    repoRoot: "/Users/demo/north-one",
    branch: "zeros/design-launch-system",
    baseBranch: "main",
    path: workspacePath,
    status: "in-progress" as const,
    createdAt: workbenchHarness ? 0 : Date.now(),
    archivedAt: null,
    stashRef: null,
    prNumber: 42,
    prState: "ready" as const,
    prUrl: "https://github.com/example/north-one/pull/42",
    agentId: null,
    lastActiveAt: Date.now(),
  };
  const workspaces = workbenchHarness ? [workspace, ...["second", "third"].map((suffix) => ({ ...workspace, id: `${workspaceId}_${suffix}`, path: `${workspacePath}-${suffix}`, branch: `${workspace.branch}-${suffix}` }))] : [workspace];
  const workbenchOperations: string[] = [];
  (window as Window & { __zerosHarnessWorkbenchOperations?: string[] }).__zerosHarnessWorkbenchOperations = workbenchOperations;
  localStorage.setItem(
    "zeros-projects-v1",
    JSON.stringify([
      {
        id: "project_north_one",
        name: "North One",
        repoRoot: workspace.repoRoot,
        repoSlug: workspace.repoSlug,
        originUrl: "https://github.com/example/north-one.git",
        addedAt: 1,
      },
    ]),
  );

  const React = await import("react");
  const WorkbenchPane = workbenchHarness ? (await import("../shell/workbench/workbench-pane")).WorkbenchPane : null;
  const ConversationPane = workbenchHarness ? (await import("../shell/conversation/conversation-pane")).ConversationPane : null;
  const ReferenceFixture = selectionReferencesHarness ? (await import("./harness-design-selection-reference")).DesignSelectionReferenceFixture : null;
  const { ActionsCtx } = await import("../features/agent/sessions-context");
  const { createRoot } = await import("react-dom/client");
  const { flushSync } = await import("react-dom");
  // Preview races must use this harness's exact runtime even when Chromium's
  // bounded resource-timing buffer no longer contains its dependency URLs.
  (window as Window & {
    __zerosDesignHarnessRuntime?: {
      React: typeof React;
      createRoot: typeof createRoot;
      flushSync: typeof flushSync;
    };
  }).__zerosDesignHarnessRuntime = { React, createRoot, flushSync };
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { Toaster } = await import("../shared/ui/primitives/elements/toast");
  const { DesignWorkspaceColumn } =
    await import("../features/design-workspace/design-workspace");
  const RetainedDesignDeck = retainedContinuityHarness ? (await import("../shell/workbench/design-deck")).RetainedDesignDeck : null;
  const {
    applyDesignWorkspaceRefreshVersion,
    designFoundationCache,
    designFoundationKey,
    designFrameDocumentCache,
    designFrameDocumentKey,
    designWorkspaceSnapshotCache,
    hasPendingDesignEdits,
    setDesignNodeTextCached,
    updateDesignNodeStylesCached,
  } = await import("../features/design-workspace/state/design-workspace-cache");
  const { captureDesignRuntimeScreenshot } =
    await import("../features/design-workspace/state/design-selection");
  const { designFrameCopyGeometry } =
    await import("../features/design-workspace/design-frame-copy-gesture");
  const { useDesignWorkspaceUiStore } =
    await import("../features/design-workspace/state/design-workspace-ui");
  const { useDesignRuntimeStore } =
    await import("../features/design-workspace/state/design-runtime-store");
  const { designRendererResources } =
    await import("../features/design-workspace/state/design-renderer-resources");
  const { designFramePreviews } =
    await import("../features/design-workspace/state/use-design-frame-previews");
  const { setActiveBridge } = await import("../platform/bridge/active-bridge");
  const { setWorkspaceRowsForTesting } = await import("../state/use-projects");
  const { useWorkspaceStore } = await import("../state/store");
  if (attributeContinuityHarness) {
    const { installDesignAttribution } = await import("./harness-design-attribution");
    const { useDesignLayerDisclosureStore } = await import("../features/design-workspace/state/design-layer-disclosure");
    const { designHiddenDocuments } = await import("../features/design-workspace/state/design-hidden-documents");
    const { subscribeDesignFrameIntent } = await import("../features/design-workspace/state/design-frame-intent");
    const { designCheckoutStatusCache, designDirectoryTargetCache, designDirectoryListingCache } = await import("../state/read-caches");
    const dispose = installDesignAttribution({
      stores: { ui: useDesignWorkspaceUiStore, runtime: useDesignRuntimeStore, disclosure: useDesignLayerDisclosureStore, workspace: useWorkspaceStore },
      caches: { aggregate: designWorkspaceSnapshotCache, documents: designFrameDocumentCache, foundation: designFoundationCache,
        checkout: designCheckoutStatusCache, directory: designDirectoryTargetCache, directories: designDirectoryListingCache },
      previews: designFramePreviews, hiddenDocuments: designHiddenDocuments, subscribeIntent: subscribeDesignFrameIntent,
    });
    window.addEventListener("pagehide", dispose, { once: true });
  }
  if (workbenchHarness) {
    (window as Window & {
      __zerosHarnessSelectWorkspace?: (id: string) => void;
    }).__zerosHarnessSelectWorkspace = (id) => {
      const destination = workspaces.find((row) => row.id === id);
      if (!destination) throw new Error("Unknown Design harness workspace");
      useWorkspaceStore.setState({
        activeChatId: null,
        newAgentFolder: destination.path,
      });
    };
  }

  setWorkspaceRowsForTesting(workspace.repoSlug, workspaces);
  useWorkspaceStore.setState({
    activeChatId: null,
    newAgentFolder: workspacePath,
  });
  const retainMeasurementScope = (folder: string) => {
    if (retainedContinuityHarness) useWorkspaceStore.getState().dispatch({
      type: "ADD_WORKBENCH_TAB", scope: folder,
      tab: { id: "design", type: "design", title: "Design" },
    });
  };
  retainMeasurementScope(workspacePath);
  const reviewFindings = Array.from({ length: 95 }, (_, index) => ({
    ruleId: "spacing-scale" as const,
    severity: "warning" as const,
    message: `Spacing is off the 4px design scale on layer ${index + 1}.`,
    file: "home.html",
    line: index + 1,
    column: 1,
    oid: `home-review-${index + 1}`,
    fix: "Use a design spacing token or a multiple of 4px.",
  }));
  designWorkspaceSnapshotCache.setData(workspaceId, {
    protocolCapability: null,
    ...(selectionReferencesHarness || picturesHarness ? { directoryId: "design_harness", directory: "North One - Design" } : {}),
    frames: [
      {
        file: "home.html",
        title: "Launch home",
        width: 1_440,
        height: 900,
        x: 0,
        y: 0,
        z: 0,
        nodeCount: 12,
        modifiedAt: 1,
        sourceVersion: HOME_SOURCE_VERSION,
      },
      {
        file: "pricing.html",
        title: "Pricing",
        width: 1_440,
        height: 900,
        x: 1_560,
        y: 0,
        z: 1,
        nodeCount: 18,
        modifiedAt: 2,
        sourceVersion: PRICING_SOURCE_VERSION,
      },
    ],
    tokens: [
      {
        name: "--accent",
        syntax: "<color>",
        inherits: true,
        initialValue: "royalblue",
        value: "royalblue",
        themeValues: { dark: "lightskyblue" },
        usageCount: 2,
        line: 1,
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        name: `--space-${index + 1}`,
        syntax: "<length>",
        inherits: true,
        initialValue: `${(index + 1) * 4}px`,
        value: `${(index + 1) * 4}px`,
        themeValues: {},
        usageCount: index % 4,
        line: index + 2,
      })),
    ],
    tokenSourceVersion: "tokens-source-version-1",
    ...(styleSourcesHarness
      ? { styleSources: HARNESS_STYLE_SOURCES, styleSourceErrors: [] }
      : designTokensHarness
        ? {
            styleSources: [{ ...HARNESS_STYLE_SOURCES![0]!, title: "App styles", status: "ready" as const, messages: [] }],
            styleSourceErrors: [],
          }
        : {}),
    assets: [],
    lint: {
      workspacePath,
      checkedFiles: ["home.html", "pricing.html"],
      violations: reviewFindings,
      healedOids: 0,
    },
  });
  // Keep server replies independent of the renderer cache so a slow/cold read
  // exercises the same state as an engine-backed document.
  const foundationReplies = new Map<string, DesignFoundationOpenWire>();
  let foundationReadsHeld = new URLSearchParams(window.location.search).has(
    "coldFoundation",
  );
  let releaseFoundationReads: () => void = () => {};
  const foundationReadGate = foundationReadsHeld
    ? new Promise<void>((resolve) => {
        releaseFoundationReads = () => {
          foundationReadsHeld = false;
          resolve();
        };
      })
    : Promise.resolve();
  const foundationControl = {
    reads: [] as Array<{ frame: string; sourceVersion: string | undefined }>,
    transactions: [] as Array<{
      frame: string;
      documentId: string;
      baseRevision: string;
      nodeIds: string[];
    }>,
    release: releaseFoundationReads,
  };
  (
    window as Window & {
      __zerosHarnessFoundation?: typeof foundationControl;
    }
  ).__zerosHarnessFoundation = foundationControl;
  const publishFoundation = (
    key: string,
    foundation: DesignFoundationOpenWire,
  ) => {
    foundationReplies.set(key, foundation);
    if (!foundationReadsHeld) designFoundationCache.setData(key, foundation);
  };
  for (const [file, sourceVersion, nodeCount] of [
    ["home.html", HOME_SOURCE_VERSION, 12],
    ["pricing.html", PRICING_SOURCE_VERSION, 18],
  ] as const) {
    publishFoundation(designFoundationKey(workspaceId, file, sourceVersion), {
      summary: {
        apiVersion: 1,
        documentId: `harness:${file}`,
        revision: `harness:${sourceVersion}`,
        entryFile: file,
        fileCount: 1,
        nodeCount,
        valid: true,
        diagnostics: [],
        lastValidRevision: `harness:${sourceVersion}`,
        history: {
          canUndo: false,
          canRedo: false,
          undoDepth: 0,
          redoDepth: 0,
          retainedBytes: 0,
          retainedReceiptBytes: 0,
          revision: `harness:${sourceVersion}`,
          lastReconciliationReason: null,
        },
      },
      foundation: {
        documentId: `harness:${file}`,
        revision: `harness:${sourceVersion}`,
        manifest: {
          schemaVersion: 1,
          parameters: [],
          variants: [],
          components: [],
        },
        keyframes: readDesignKeyframes({
          [file]: file === "home.html" ? homeSource : pricingSource,
        }),
      },
    } as never);
  }
  designFrameDocumentCache.setData(
    designFrameDocumentKey(workspaceId, "home.html", HOME_SOURCE_VERSION),
    {
      file: "home.html",
      title: "Launch home",
      width: 1_440,
      height: 900,
      x: 0,
      y: 0,
      z: 0,
      nodeCount: 12,
      modifiedAt: 1,
      sourceVersion: HOME_SOURCE_VERSION,
      source: homeSource,
      srcDoc: withDesignRuntime(homeSource, HOME_SOURCE_VERSION),
      tree: [],
    },
  );
  designFrameDocumentCache.setData(
    designFrameDocumentKey(workspaceId, "pricing.html", PRICING_SOURCE_VERSION),
    {
      file: "pricing.html",
      title: "Pricing",
      width: 1_440,
      height: 900,
      x: 1_560,
      y: 0,
      z: 1,
      nodeCount: 18,
      modifiedAt: 2,
      sourceVersion: PRICING_SOURCE_VERSION,
      source: pricingSource,
      srcDoc: withDesignRuntime(pricingSource, PRICING_SOURCE_VERSION),
      tree: [],
    },
  );
  const frameDetails = {
    sourceVersion: HOME_SOURCE_VERSION,
    oid: "home-main",
    tag: "main",
    name: "main",
    text: null,
    selector: '[data-oid="home-main"]',
    visible: true,
    breadcrumb: ["body · body", "main · main"],
    rect: { x: 0, y: 0, width: 1_440, height: 900 },
    styles: {
      display: "flex",
      flexDirection: "column",
      gap: "normal",
      padding: "72px",
      paddingTop: "72px",
      paddingRight: "72px",
      paddingBottom: "72px",
      paddingLeft: "72px",
      background: "transparent",
      border: "0px none var(--fg1)",
      borderRadius: "0px",
    },
    authoredStyleProperties: ["padding"],
  };
  const headingDetails = {
    sourceVersion: HOME_SOURCE_VERSION,
    oid: "home-heading",
    tag: "h1",
    name: "Make the next move unmistakable.",
    text: "Make the next move unmistakable.",
    selector: '[data-oid="home-heading"]',
    visible: true,
    breadcrumb: ["body · body", "main · main", "h1 · Make the next move"],
    rect: { x: 72, y: 280, width: 900, height: 168 },
    styles: {
      position: "relative",
      left: "0px",
      top: "0px",
      width: "900px",
      height: "168px",
      display: "block",
      flexDirection: "row",
      gap: "normal",
      padding: "0px",
      paddingTop: "0px",
      paddingRight: "0px",
      paddingBottom: "0px",
      paddingLeft: "0px",
      marginTop: "0px",
      marginRight: "0px",
      marginBottom: "0px",
      marginLeft: "0px",
      alignItems: "normal",
      justifyContent: "normal",
      background: "transparent",
      border: "0px none var(--fg1)",
      borderRadius: "0px",
      color: "var(--fg1)",
      fontSize: "88px",
      fontWeight: "700",
      lineHeight: "83.6px",
      letterSpacing: "-5.28px",
      textAlign: "start",
    },
    authoredStyleProperties: [
      "margin",
      "fontSize",
      "fontWeight",
      "lineHeight",
      "letterSpacing",
    ],
  };
  useDesignRuntimeStore.getState().publishSnapshot(
    workspaceId,
    workspacePath,
    "home.html",
    {
      sourceVersion: HOME_SOURCE_VERSION,
      revision: 1,
      warnings: [],
      tree: [
        {
          oid: "home-body",
          tag: "body",
          name: "body",
          text: null,
          visible: true,
          children: [
            {
              oid: "home-main",
              tag: "main",
              name: "main",
              text: null,
              visible: true,
              children: [
                {
                  oid: "home-heading",
                  tag: "h1",
                  name: headingDetails.name,
                  text: headingDetails.text,
                  visible: true,
                  children: [],
                },
                ...Array.from({ length: HARNESS_LAYER_COUNT }, (_, index) => ({
                  oid: `home-layer-${index + 1}`,
                  tag: "span",
                  name: `Layer ${index + 1}`,
                  text: `Layer ${index + 1}`,
                  visible: false,
                  children: [],
                })),
              ],
            },
          ],
        },
      ],
      frame: frameDetails,
      viewport: { width: 1_440, height: 900, scrollX: 0, scrollY: 0 },
    },
    HOME_SOURCE_VERSION,
  );
  useDesignRuntimeStore
    .getState()
    .publishNodeDetails(
      workspaceId,
      workspacePath,
      "home.html",
      headingDetails,
      HOME_SOURCE_VERSION,
    );
  if (!pagesHarness) useDesignWorkspaceUiStore
    .getState()
    .setSelection(workspaceId, "home.html", "home-heading");

  const performanceSources = new Map<string, string>();
  let currentWorkspaceSnapshot =
    designWorkspaceSnapshotCache.getSnapshot(workspaceId).data!;
  let lazyRevision = "a".repeat(64);
  let releasePreparation: (() => void) | null = null;
  let preparationBarrier: Promise<void> | null = null;
  const preparationCalls: Array<{ workspaceId: string; files: string[] }> = [];
  let textCommitBarrier: Promise<void> | null = null;
  let releaseTextCommit: (() => void) | null = null;
  let heldTextCommits = 0;
  const holdTextCommit = () => {
    if (textCommitBarrier) return;
    textCommitBarrier = new Promise<void>((resolve) => { releaseTextCommit = () => { textCommitBarrier = null; releaseTextCommit = null; resolve(); }; });
  };
  const holdPreparation = () => {
    if (preparationBarrier) return;
    preparationBarrier = new Promise<void>((resolve) => { releasePreparation = () => { preparationBarrier = null; releasePreparation = null; resolve(); }; });
  };
  if (lazyPreparationHarness) {
    const near = currentWorkspaceSnapshot.frames.map((frame, index) => ({ ...frame, frameId: `f${index}`, pageId: "main", kind: "frame" as const }));
    const distant = Array.from({ length: measureContinuityHarness ? 0 : 254 }, (_, index) => ({ ...near[0]!, file: `distant-${index}.html`, frameId: `d${index}`,
      title: `Distant ${index}`, x: 20_000 + index * 1600, z: 0 }));
    for (const frame of distant) performanceSources.set(frame.file, homeSource);
    const frames = [...near, ...distant];
    currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, directoryId: "design_harness", directory: "North One - Design", frames,
      pages: [{ id: "main", title: "Design", folder: "", frameFiles: frames.map((frame) => frame.file), frameIds: frames.map((frame) => frame.frameId) }],
      lint: { ...currentWorkspaceSnapshot.lint, checkedFiles: [], violations: [] } };
    designWorkspaceSnapshotCache.forget(workspaceId);
    designFrameDocumentCache.clear();
    useDesignRuntimeStore.getState().forgetWorkspace(workspaceId);
    if (!measureContinuityHarness) holdPreparation();
  }
  const lazyCatalogOwner = (id: string) => ({ workspaceId: id, directoryId: "design_harness", placement: "local", organizationId: id === workspaceId ? null : "organization-local" });
  const pagesFixture = pagesHarness ? createDesignPagesHarness(currentWorkspaceSnapshot, homeSource) : null;
  if (pagesFixture) {
    currentWorkspaceSnapshot = pagesFixture.snapshot;
    designWorkspaceSnapshotCache.setData(workspaceId, currentWorkspaceSnapshot);
    const remembered = useDesignWorkspaceUiStore.getState().byWorkspace[workspaceId];
    if (!remembered?.activePageId) useDesignWorkspaceUiStore.getState().setSelection(workspaceId, "page-1/home.html", null);
    for (const document of pagesFixture.documents) {
      designFrameDocumentCache.setData(designFrameDocumentKey(workspaceId, document.file, document.sourceVersion), {
        ...document, srcDoc: withDesignRuntime(document.source, document.sourceVersion),
      });
      publishFoundation(designFoundationKey(workspaceId, document.file, document.sourceVersion), pagesFixture.foundation(document) as DesignFoundationOpenWire);
    }
  }
  let currentHomeSource = homeSource;
  let currentPricingSource = pricingSource;
  let nestedFrameCounter = 0;
  let styleGenerationCounter = 0;
  let textTransactionCounter = 0;
  let htmlFrameCounter = 0;
  let looseTextFrameCounter = 0;
  let appendedTextCounter = 0;
  const frameDeletionUndo: Array<
    (typeof currentWorkspaceSnapshot.frames)[number]
  > = [];
  const frameDeletionRedo: Array<
    (typeof currentWorkspaceSnapshot.frames)[number]
  > = [];
  const nextStyleSourceVersion = () => {
    styleGenerationCounter += 1;
    return styleGenerationCounter.toString(16).padStart(24, "c");
  };
  const styleMutationSources: string[] = [];
  const designShortcutOperations: string[] = [];
  const designThemeUpdates: Array<{ id: string; label: string; base?: boolean }> = [];
  let designStyleRefreshes = 0;
  let reviewStaged = false;
  let reviewCommitted = false;
  let reviewCaptured = false;
  const evidence = () => ({ id: "c".repeat(64), baseRevision: "harness-review-base", revision: "harness-review-after", createdAt: Date.now(), viewport: { width: 1, height: 1, deviceScaleFactor: 1 }, renderer: "harness" });
  let reviewProposalStatus: "proposed" | "committed" | "rejected" = "proposed";
  const reviewProposal = () => ({ id: "proposal-review", actorId: "Design agent", signature: "a".repeat(64),
    createdAt: 1_700_000_000_000, status: reviewProposalStatus, intent: "Refine the heading spacing", documentId: "frame:home.html",
    baseRevision: "harness-review-base", operationCount: 1,
    ...(reviewProposalStatus !== "proposed" ? { review: { decision: reviewProposalStatus === "committed" ? "accept" : "reject", reviewerId: "desktop", reviewedAt: 1_700_000_000_001 } } : {}) });

  (
    window as Window & {
      __zerosHarnessStyleMutationSources?: string[];
    }
  ).__zerosHarnessStyleMutationSources = styleMutationSources;
  (
    window as Window & {
      __zerosHarnessDesignShortcutOperations?: string[];
    }
  ).__zerosHarnessDesignShortcutOperations = designShortcutOperations;
  (
    window as Window & {
      __zerosHarnessDesignThemeUpdates?: typeof designThemeUpdates;
      __zerosHarnessDesignStyleRefreshes?: () => number;
    }
  ).__zerosHarnessDesignThemeUpdates = designThemeUpdates;
  (
    window as Window & { __zerosHarnessDesignStyleRefreshes?: () => number }
  ).__zerosHarnessDesignStyleRefreshes = () => designStyleRefreshes;
  // Agent-draft smoke: report the directory name an engine snapshot carries,
  // and land a new home.html generation the way an agent's Write saves before
  // any watcher event (the smoke then sends the Design-only refresh).
  (
    window as Window & {
      __zerosHarnessAgentDrafts?: {
        workspaceId: string;
        directory: string;
        useDirectory(): void;
        save(source: string, sourceVersion: string): void;
      };
    }
  ).__zerosHarnessAgentDrafts = {
    workspaceId,
    directory: "North One - Design",
    useDirectory() {
      currentWorkspaceSnapshot = {
        ...currentWorkspaceSnapshot,
        directory: "North One - Design",
      };
      designWorkspaceSnapshotCache.setData(workspaceId, currentWorkspaceSnapshot);
    },
    save(source, sourceVersion) {
      const previousVersion = currentWorkspaceSnapshot.frames.find((frame) => frame.file === "home.html")?.sourceVersion;
      const previousFoundation = previousVersion ? foundationReplies.get(designFoundationKey(workspaceId, "home.html", previousVersion)) : undefined;
      if (previousFoundation) {
        const revision = `harness:${sourceVersion}`;
        publishFoundation(designFoundationKey(workspaceId, "home.html", sourceVersion), {
          ...previousFoundation,
          summary: {
            ...previousFoundation.summary,
            revision,
            lastValidRevision: revision,
            history: { ...previousFoundation.summary.history, revision },
          },
          foundation: { ...previousFoundation.foundation, revision },
        });
      }
      currentHomeSource = source;
      currentWorkspaceSnapshot = {
        ...currentWorkspaceSnapshot,
        frames: currentWorkspaceSnapshot.frames.map((frame) =>
          frame.file === "home.html"
            ? { ...frame, sourceVersion, modifiedAt: Date.now() }
            : frame,
        ),
      };
    },
  };
  const layoutUndo: Array<{
    source: string;
    snapshot: typeof currentWorkspaceSnapshot;
    kind?: "geometry" | "transfer";
    frame?: string;
  }> = [];
  const layoutRedo: typeof layoutUndo = [];
  type FixtureRequest = { type?: string; op?: string; params?: Record<string, unknown> };
  let mutationCatalogGeneration = 0;
  const withScopedMutationSnapshots = (request: (message: FixtureRequest) => Promise<unknown>) => async (message: FixtureRequest) => {
    const reply = await request(message) as { result?: { snapshot?: DesignWorkspaceSnapshotWire; frame?: string | { file: string } } };
    if (!scopedMutationsHarness || !reply.result?.snapshot || message.op === "design.navigation.read") return reply;
    const original = reply.result.snapshot;
    const frames = original.frames.map(frame => ({ ...frame, pageId: "main",
      frameId: frame.frameId ?? `fixture_${frame.file.replace(/[^a-zA-Z0-9_-]/g, "_")}` }));
    const snapshot = { ...original, frames, pages: [{ id: "main", title: "Design", folder: "",
      frameFiles: frames.map(frame => frame.file), frameIds: frames.map(frame => frame.frameId) }] };
    if (original === currentWorkspaceSnapshot) currentWorkspaceSnapshot = snapshot;
    if (message.params?.snapshotMode !== "scoped") return { ...reply, result: { ...reply.result, snapshot } };
    lazyRevision = (++mutationCatalogGeneration).toString(16).padStart(64, "0");
    const resultFrame = reply.result.frame;
    const affected = new Set([
      ...(typeof message.params.frame === "string" ? [message.params.frame] : []),
      ...(typeof resultFrame === "string" ? [resultFrame] : resultFrame ? [resultFrame.file] : []),
      ...((message.params.moves ?? []) as Array<{ frame: string }>).map(move => move.frame),
      ...((message.params.transaction as { operations?: Array<{ type: string; frame?: string }> } | undefined)?.operations ?? [])
        .flatMap(operation => operation.type === "frame.set-geometry" && operation.frame ? [operation.frame] : []),
    ]);
    return { ...reply, result: { ...reply.result, snapshot: { ...snapshot,
      mutationCatalog: { revision: lazyRevision, frames: frames.map((frame, order) => ({
        id: frame.frameId, pageId: frame.pageId, source: frame.file, title: frame.title,
        kind: frame.kind === "text" ? "text" : "html", x: frame.x, y: frame.y, width: frame.width, height: frame.height,
        z: frame.z, order, preparation: "unprepared",
      })) },
      frames: frames.filter(frame => affected.has(frame.file)),
      lint: { ...snapshot.lint, checkedFiles: snapshot.lint.checkedFiles.filter(file => affected.has(file)),
        violations: snapshot.lint.violations.filter(violation => affected.has(violation.file)) },
    } } };
  };
  setActiveBridge({
    executionIdentity: { kind: "local", sidecar: "active" },
    status: "connected",
    on: () => () => {},
    onStatusChange: () => () => {},
    supportsEngineCapability: (capability: string) => capability === "design.copy-placement.v1" ||
      scopedMutationsHarness && capability === "design.mutation-snapshots.v1" ||
      lazyPreparationHarness && ["design.preparation.v1", "design.catalog.read.v1"].includes(capability),
    requestConnected: async (message: { op: string; params: { workspaceId: string; intent: number } }) => {
      if (!lazyPreparationHarness || message.op !== "design.catalog.read") throw new Error("Unexpected connected fixture request.");
      const frames = currentWorkspaceSnapshot.frames.map((frame, order) => ({ id: frame.frameId!, pageId: frame.pageId!, source: frame.file,
        title: frame.title, kind: frame.kind === "text" ? "text" : "html", x: frame.x, y: frame.y, width: frame.width, height: frame.height,
        z: frame.z, order, preparation: "unprepared" }));
      return { type: "WORKSPACE_RESPONSE", op: message.op, result: { kind: "design-catalog", version: 1, status: "ready", owner: lazyCatalogOwner(message.params.workspaceId),
        intent: message.params.intent, binding: "b".repeat(64), revision: lazyRevision, pages: [{ id: "main", title: "Design", folder: "", count: frames.length }],
        total: frames.length, offset: 0, frames, coverage: "complete", nextCursor: null } };
    },
    request: withScopedMutationSnapshots(async (message: {
      type?: string;
      op?: string;
      params?: Record<string, unknown>;
    }) => {
      if (message.op) workbenchOperations.push(message.op);
      if (measureContinuityHarness && message.op && delayedOperations.has(message.op)) {
        const request = { op: message.op, workspaceId: String(message.params?.workspaceId), started: performance.now(), released: null as number | null };
        delayedRequests.push(request);
        if (delayedRequests.length > 256) delayedRequests.shift();
        await new Promise(resolve => window.setTimeout(resolve, engineDelayMs));
        await measurementHolds.get(message.op)?.promise;
        request.released = performance.now();
      }
      if (measureManipulationHarness && ["design.canvas.update", "design.frames.move", "design.node.transfer"].includes(message.op ?? "")) {
        layoutUndo.push({ source: currentHomeSource, snapshot: currentWorkspaceSnapshot,
          kind: message.op === "design.node.transfer" ? "transfer" : "geometry",
          frame: String(message.params?.frame ?? (message.params?.moves as Array<{ frame: string }> | undefined)?.[0]?.frame ?? "home.html") });
        if (layoutUndo.length > 64) layoutUndo.shift();
        layoutRedo.length = 0;
      }
      if (lazyPreparationHarness && message.op === "design.navigation.read") {
        const owner = lazyCatalogOwner(String(message.params?.workspaceId));
        return { type: "WORKSPACE_RESPONSE", result: { owner, catalogRevision: lazyRevision,
          snapshot: { ...currentWorkspaceSnapshot, frames: [], lint: { ...currentWorkspaceSnapshot.lint,
            workspacePath: workspaces.find((row) => row.id === owner.workspaceId)?.path ?? workspacePath },
            ...(measureContinuityHarness ? { pages: [{ id: "main", title: "Design", folder: "",
              frameFiles: currentWorkspaceSnapshot.frames.map(frame => frame.file), frameIds: currentWorkspaceSnapshot.frames.map(frame => frame.frameId) }] } : {}) } } };
      }
      if (lazyPreparationHarness && message.op === "design.frames.prepare") {
        const files = message.params?.files as string[];
        preparationCalls.push({ workspaceId: String(message.params?.workspaceId), files: [...files] });
        const result = { directoryId: "design_harness", catalogRevision: lazyRevision,
          frames: currentWorkspaceSnapshot.frames.filter((frame) => files.includes(frame.file)), errors: [] };
        if (preparationBarrier) await preparationBarrier;
        return { type: "WORKSPACE_RESPONSE", result };
      }
      if (pagesFixture) {
        const result = await pagesFixture.request(message.op, message.params);
        if (result !== undefined) {
          currentWorkspaceSnapshot = pagesFixture.snapshot;
          const reply = result as { frame?: { source?: string; sourceVersion: string; srcDoc: string } };
          if (reply.frame?.source) reply.frame.srcDoc = withDesignRuntime(reply.frame.source, reply.frame.sourceVersion);
          return { type: "WORKSPACE_RESPONSE", result };
        }
      }
      if (workbenchHarness && message.op === "file.tree") return { type: "WORKSPACE_RESPONSE", result: { files: [], truncated: false, designDirectories: ["North One - Design"] } };
      if (workbenchHarness && message.op === "file.ignored") return { type: "WORKSPACE_RESPONSE", result: { files: [], truncated: false } };
      if (workbenchHarness && message.op === "settings.resolve") return { type: "WORKSPACE_RESPONSE", result: { effective: { scripts: {}, design: {} }, sources: {}, warnings: [] } };
      if (workbenchHarness && message.op === "workspace.setupInfo") return { type: "WORKSPACE_RESPONSE", result: { state: "not-configured", hasCommand: false, command: null, truncated: false, log: "" } };
      if (message.op === "design.status") return { type: "WORKSPACE_RESPONSE", result: { conflicts: new URLSearchParams(location.search).has("conflicts") ? ["North One - Design/design.toml"] : [], operation: new URLSearchParams(location.search).has("conflicts") ? "merge" : null } };
      if (message.op === "design.listDirectories") return { type: "WORKSPACE_RESPONSE", result: { directories: ["North One - Design"], directoryIds: { "North One - Design": "design_harness" }, active: "North One - Design", pointer: "North One - Design", target: { directory: "North One - Design", exists: true } } };
      if (workbenchHarness && message.op === "workspace.list") return { type: "WORKSPACE_RESPONSE", result: { workspaces: message.params?.archived === true ? [] : workspaces } };
      if (workbenchHarness && message.op === "git.status") return { type: "WORKSPACE_RESPONSE", result: { staged: [], unstaged: [], untracked: [], conflicted: [], conflictState: null, branch: workspace.branch, upstream: null, ahead: 0, behind: 0 } };
      if (workbenchHarness && message.op === "git.changeCounts") return { type: "WORKSPACE_RESPONSE", result: { all: 0, uncommitted: 0, staged: 0, unstaged: 0 } };
      if (message.op === "design.preview") {
        // A capture host stand-in: one flat picture at the requested raster.
        const params = message.params!;
        const requests = ((window as typeof window & {
          __zerosHarnessPreviewRequests?: unknown[];
        }).__zerosHarnessPreviewRequests ??= []);
        requests.push({ ...params });
        const frame = currentWorkspaceSnapshot.frames.find((candidate) => candidate.file === params.frame);
        if (!frame) throw new Error(`Design frame not found: ${String(params.frame)}`);
        if (frame.sourceVersion !== params.sourceVersion)
          return { type: "WORKSPACE_RESPONSE", result: { stale: true, sourceVersion: frame.sourceVersion } };
        const scale = Math.min(1, Number(params.maxDimension) / Math.max(frame.width, frame.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(frame.width * scale));
        canvas.height = Math.max(1, Math.round(frame.height * scale));
        const context = canvas.getContext("2d")!;
        if (frame.kind === "text") {
          context.fillStyle = "white";
          context.font = "12px sans-serif";
          context.fillText("Text preview", 4, 16);
        } else {
          context.fillStyle = "steelblue";
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            sourceVersion: frame.sourceVersion,
            theme: (params.theme as string | null | undefined) ?? null,
            mimeType: "image/png",
            width: canvas.width,
            height: canvas.height,
            data: canvas.toDataURL("image/png").slice("data:image/png;base64,".length),
          },
        };
      }
      if (layoutGestureHarness && message.op === "design.frames.move") {
        // Several frames in one write: record it and apply every move, as the
        // engine route does after checking each frame's measured geometry.
        const moves = (message.params!.moves ?? []) as Array<{
          frame: string;
          from: { x: number; y: number; w: number; h: number; z: number };
          to: { x: number; y: number; w: number; h: number; z: number };
        }>;
        const requests = ((window as typeof window & {
          __zerosHarnessFrameMoves?: unknown[];
        }).__zerosHarnessFrameMoves ??= []);
        requests.push(moves);
        const byFile = new Map(moves.map((move) => [move.frame, move]));
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map((frame) => {
            const move = byFile.get(frame.file);
            return move
              ? { ...frame, x: move.to.x, y: move.to.y, width: move.to.w, height: move.to.h, z: move.to.z }
              : frame;
          }),
        };
        designShortcutOperations.push("frames:confirmed");
        return { type: "WORKSPACE_RESPONSE", result: { snapshot: currentWorkspaceSnapshot } };
      }
      if (layoutGestureHarness && message.op === "design.canvas.update") {
        const params = message.params!;
        designShortcutOperations.push("canvas:waiting");
        if (!measureManipulationHarness)
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        // Record the request, then clamp exactly like the engine route.
        const requests = ((window as typeof window & {
          __zerosHarnessCanvasUpdates?: unknown[];
        }).__zerosHarnessCanvasUpdates ??= []);
        requests.push({ ...params });
        const size = (value: unknown) =>
          Math.min(16_384, Math.max(1, Number(value)));
        const geometry = {
          x: Number(params.x),
          y: Number(params.y),
          w: size(params.w),
          h: size(params.h),
          z: Number(params.z),
        };
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map((frame) =>
            frame.file === params.frame
              ? {
                  ...frame,
                  x: geometry.x,
                  y: geometry.y,
                  width: geometry.w,
                  height: geometry.h,
                  z: geometry.z,
                }
              : frame,
          ),
        };
        designShortcutOperations.push("canvas:confirmed");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { geometry, snapshot: currentWorkspaceSnapshot },
        };
      }
      if (layoutGestureHarness && message.op === "design.frame.duplicate") {
        const params = message.params!;
        const original = currentWorkspaceSnapshot.frames.find(frame => frame.file === params.frame)!;
        if (params.sourceVersion && params.sourceVersion !== original.sourceVersion) throw new Error("The copied source changed.");
        if ((window as Window & { __zerosHarnessRejectFrameDuplicate?: boolean }).__zerosHarnessRejectFrameDuplicate)
          throw new Error("The copy was refused.");
        layoutUndo.push({ source: currentHomeSource, snapshot: currentWorkspaceSnapshot });
        layoutRedo.length = 0;
        const file = `copy-${++nestedFrameCounter}.html`;
        const sourceVersion = nextStyleSourceVersion();
        const source = original.file === "home.html" ? currentHomeSource : currentPricingSource;
        const geometry = params.geometry as { x: number; y: number; w: number; h: number; z: number } | undefined;
        const frame = { ...original, file, frameId: `copy_${nestedFrameCounter}`, title: `${original.title} copy`, sourceVersion,
          ...(() => {
            // Model the engine's automatic slot (nextFrameGeometry) on the original's page.
            const placed = geometry ?? designFrameCopyGeometry(currentWorkspaceSnapshot.frames
              .filter(candidate => (candidate.pageId ?? null) === (original.pageId ?? null)), original);
            return { x: placed.x, y: placed.y, width: placed.w, height: placed.h, z: placed.z };
          })() };
        performanceSources.set(file, source);
        currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, frames: [...currentWorkspaceSnapshot.frames, frame] };
        if (currentWorkspaceSnapshot.pages) currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot,
          pages: currentWorkspaceSnapshot.pages.map(page => page.id === original.pageId ? { ...page, frameFiles: [...page.frameFiles, file],
            frameIds: [...page.frameIds ?? [], frame.frameId] } : page) };
        designFrameDocumentCache.setData(designFrameDocumentKey(workspaceId, file, sourceVersion), {
          ...frame, source, srcDoc: withDesignRuntime(source, sourceVersion), tree: [],
        });
        return { type: "WORKSPACE_RESPONSE", result: { frame, snapshot: currentWorkspaceSnapshot } };
      }
      if (layoutGestureHarness && message.op === "design.node.transfer") {
        const params = message.params!;
        designShortcutOperations.push("transfer:waiting");
        if (!measureManipulationHarness)
          await new Promise((resolve) => window.setTimeout(resolve, 700));
        if (new URLSearchParams(location.search).has("rejectTransfer"))
          throw new Error("Transfer failed in the delayed regression fixture.");
        if (params.destinationFrame && params.destinationFrame !== params.frame) {
          // A layer released over another frame joins it; a whole frame (its
          // body or its only root layer) leaves the canvas, as the engine's
          // frame-lifecycle transfer does.
          const sourceFile = String(params.frame);
          const destinationFile = String(params.destinationFrame);
          const read = (file: string) => (file === "home.html" ? currentHomeSource : currentPricingSource);
          const write = (file: string, html: string) => {
            if (file === "home.html") currentHomeSource = html;
            else currentPricingSource = html;
          };
          const moved = new DOMParser().parseFromString(read(sourceFile), "text/html");
          const destinationDocument = new DOMParser().parseFromString(read(destinationFile), "text/html");
          const wholeFrame = params.nodeId === DESIGN_RUNTIME_DOCUMENT_BODY_ID;
          let nodeId = String(params.nodeId);
          let layer: HTMLElement;
          let removeFrame = wholeFrame;
          if (wholeFrame) {
            nestedFrameCounter += 1;
            nodeId = `frame-nested${nestedFrameCounter}`;
            layer = destinationDocument.createElement("div");
            layer.setAttribute("data-oid", nodeId);
            layer.innerHTML = moved.body.innerHTML;
          } else {
            const element = moved.querySelector<HTMLElement>(`[data-oid="${CSS.escape(nodeId)}"]`)!;
            removeFrame = element.hasAttribute("data-zeros-frame-root") &&
              [...moved.body.children].filter((child) => child.hasAttribute("data-oid")).length === 1;
            element.remove();
            element.removeAttribute("data-zeros-frame-root");
            layer = destinationDocument.importNode(element, true) as HTMLElement;
          }
          if (typeof params.duplicateNodeId === "string") {
            const cloned = mutateDesignNodeDeleteSource(mutateDesignNodeDuplicateSource(layer.outerHTML, nodeId, params.duplicateNodeId), nodeId);
            layer = new DOMParser().parseFromString(cloned, "text/html").body.firstElementChild as HTMLElement;
            nodeId = params.duplicateNodeId;
            removeFrame = false;
          }
          const background = typeof params.frameBackground === "string" ? params.frameBackground : null;
          if (background) layer.style.setProperty("background-color", background);
          if (params.relocation)
            for (const [property, value] of Object.entries(designRelocationStyles(designRelocationSchema.parse(params.relocation))))
              layer.style.setProperty(property, value);
          else
            for (const [property, value] of Object.entries((params.styles ?? {}) as Record<string, string | null>))
              if (value === null) layer.style.removeProperty(property);
              else layer.style.setProperty(property, value);
          const parentId = String(params.parentId ?? DESIGN_RUNTIME_DOCUMENT_BODY_ID);
          const parent = parentId === DESIGN_RUNTIME_DOCUMENT_BODY_ID
            ? destinationDocument.body
            : destinationDocument.querySelector<HTMLElement>(`[data-oid="${CSS.escape(parentId)}"]`)!;
          if (params.parentStyles) parent.style.setProperty("position", "relative");
          const before = params.beforeId ? destinationDocument.querySelector(`[data-oid="${CSS.escape(String(params.beforeId))}"]`) : null;
          parent.insertBefore(layer, before);
          const versions = new Map<string, string>();
          const documents = new Map<string, string>();
          documents.set(destinationFile, `<!doctype html>${destinationDocument.documentElement.outerHTML}`);
          if (!removeFrame && !params.duplicateNodeId) documents.set(sourceFile, `<!doctype html>${moved.documentElement.outerHTML}`);
          for (const [file, html] of documents) {
            write(file, html);
            versions.set(file, nextStyleSourceVersion());
          }
          const previous = new Map(currentWorkspaceSnapshot.frames.map((frame) => [frame.file, frame]));
          currentWorkspaceSnapshot = {
            ...currentWorkspaceSnapshot,
            frames: currentWorkspaceSnapshot.frames
              .filter((frame) => !removeFrame || frame.file !== sourceFile)
              .map((frame) => (versions.has(frame.file) ? { ...frame, sourceVersion: versions.get(frame.file)! } : frame)),
          };
          for (const [file, html] of documents) {
            const frame = previous.get(file)!;
            const sourceVersion = versions.get(file)!;
            designFrameDocumentCache.setData(designFrameDocumentKey(workspaceId, file, sourceVersion), {
              ...frame,
              sourceVersion,
              source: html,
              srcDoc: withDesignRuntime(html, sourceVersion),
              tree: [],
            });
            const foundation = foundationReplies.get(designFoundationKey(workspaceId, file, frame.sourceVersion));
            if (foundation) publishFoundation(designFoundationKey(workspaceId, file, sourceVersion), foundation);
          }
          designShortcutOperations.push("transfer:confirmed");
          return {
            type: "WORKSPACE_RESPONSE",
            result: { frame: destinationFile, nodeId, snapshot: currentWorkspaceSnapshot },
          };
        }
        const parsed = new DOMParser().parseFromString(
          currentHomeSource,
          "text/html",
        );
        const nodeId = String(params.nodeId);
        const element = parsed.querySelector<HTMLElement>(
          `[data-oid="${CSS.escape(nodeId)}"]`,
        )!;
        const file = "detached.html";
        const sourceVersion = nextStyleSourceVersion();
        const sourceFrame = currentWorkspaceSnapshot.frames[0]!;
        const detached = {
          ...sourceFrame,
          file,
          ...(measureManipulationHarness ? { frameId: "detached_frame", pageId: "main" } : {}),
          title: "Detached",
          sourceVersion,
          x: Number(params.x),
          y: Number(params.y),
          width: Number(params.w),
          height: Number(params.h),
          z: Number(params.z),
          nodeCount: 1,
        };
        element.remove();
        element.setAttribute("data-zeros-frame-root", "");
        if (params.relocation) {
          for (const [property, value] of Object.entries(designRelocationStyles(designRelocationSchema.parse(params.relocation))))
            element.style.setProperty(property, value);
        } else Object.assign(element.style, {
          position: "relative",
          left: "auto",
          top: "auto",
          width: "100%",
          height: "100vh",
        });
        const source = `<!doctype html><html>${parsed.head.outerHTML}<body>${element.outerHTML}</body></html>`;
        currentHomeSource = `<!doctype html>${parsed.documentElement.outerHTML}`;
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: [
            { ...sourceFrame, sourceVersion },
            ...currentWorkspaceSnapshot.frames.slice(1),
            detached,
          ],
        };
        if (measureManipulationHarness)
          currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, pages: [{ id: "main", title: "Design", folder: "",
            frameFiles: currentWorkspaceSnapshot.frames.map(frame => frame.file),
            frameIds: currentWorkspaceSnapshot.frames.flatMap(frame => frame.frameId ? [frame.frameId] : []) }] };
        for (const frame of [currentWorkspaceSnapshot.frames[0]!, detached]) {
          const html = frame.file === file ? source : currentHomeSource;
          designFrameDocumentCache.setData(
            designFrameDocumentKey(workspaceId, frame.file, sourceVersion),
            {
              ...frame,
              source: html,
              srcDoc: withDesignRuntime(html, sourceVersion),
              tree: [],
            },
          );
          const foundation = foundationReplies.get(
            designFoundationKey(
              workspaceId,
              "home.html",
              sourceFrame.sourceVersion,
            ),
          );
          if (foundation)
            publishFoundation(
              designFoundationKey(workspaceId, frame.file, sourceVersion),
              foundation,
            );
        }
        designShortcutOperations.push("transfer:confirmed");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { frame: file, nodeId, snapshot: currentWorkspaceSnapshot },
        };
      }
      if (
        layoutGestureHarness &&
        (message.op === "design.node.styles" ||
          message.op === "design.transaction.apply")
      ) {
        layoutUndo.push({
          source: currentHomeSource,
          snapshot: currentWorkspaceSnapshot,
        });
        layoutRedo.length = 0;
      }
      if (
        layoutGestureHarness &&
        (message.op === "design.history.undo" ||
          message.op === "design.history.redo")
      ) {
        const undo = message.op.endsWith("undo");
        const source = undo ? layoutUndo : layoutRedo;
        const destination = undo ? layoutRedo : layoutUndo;
        const previous = currentWorkspaceSnapshot;
        const restored = source.pop();
        designShortcutOperations.push("history:waiting");
        if (!measureManipulationHarness)
          await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (restored) {
          destination.push({
            source: currentHomeSource,
            snapshot: currentWorkspaceSnapshot,
            ...(restored.kind ? { kind: restored.kind, frame: restored.frame } : {}),
          });
          currentHomeSource = restored.source;
          currentWorkspaceSnapshot = restored.snapshot;
        }
        designShortcutOperations.push("history:confirmed");
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            result: restored && !restored.kind
              ? {
                  revision: `harness:${currentWorkspaceSnapshot.frames[0]!.sourceVersion}`,
                  receipt: {
                    beforeRevision: `harness:${previous.frames[0]!.sourceVersion}`,
                    afterRevision: `harness:${currentWorkspaceSnapshot.frames[0]!.sourceVersion}`,
                    status: "applied",
                  },
                }
              : null,
            historyFrame: restored?.frame ?? "home.html",
            snapshot: currentWorkspaceSnapshot,
          },
        };
      }
      if (message.op === "design.node.styles") {
        const requestedSourceVersion = String(
          message.params?.sourceVersion ?? "",
        );
        const currentSourceVersion = currentWorkspaceSnapshot.frames.find(
          (frame) => frame.file === "home.html",
        )?.sourceVersion;
        if (requestedSourceVersion !== currentSourceVersion) {
          throw new Error(
            `Design frame changed before the mutation: expected ${currentSourceVersion}, received ${requestedSourceVersion}.`,
          );
        }
        designShortcutOperations.push("style:start");
        styleMutationSources.push(requestedSourceVersion);
        const parsed = new DOMParser().parseFromString(
          currentHomeSource,
          "text/html",
        );
        const target =
          message.params?.nodeId === DESIGN_RUNTIME_DOCUMENT_BODY_ID
            ? parsed.body
            : parsed.querySelector<HTMLElement>(
                `[data-oid="${CSS.escape(String(message.params?.nodeId ?? ""))}"]`,
              );
        if (!target) throw new Error("The style target is unavailable.");
        for (const [property, value] of Object.entries(
          (message.params?.styles ?? {}) as Record<string, string | null>,
        )) {
          target.style.setProperty(property, value ?? "");
        }
        currentHomeSource = `<!doctype html>${parsed.documentElement.outerHTML}`;
        const nextSourceVersion = nextStyleSourceVersion();
        const nextWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map((frame) =>
            frame.file === "home.html"
              ? {
                  ...frame,
                  sourceVersion: nextSourceVersion,
                  modifiedAt: frame.modifiedAt + 1,
                }
              : frame,
          ),
          // Runtime audits are exact-source data. The live browser repopulates
          // this after adoption; the inspector must retain its confirmed row
          // rather than flashing it off during this engine response.
          lint: { ...currentWorkspaceSnapshot.lint, violations: [] },
        };
        designFrameDocumentCache.setData(
          designFrameDocumentKey(workspaceId, "home.html", nextSourceVersion),
          {
            ...nextWorkspaceSnapshot.frames[0]!,
            source: currentHomeSource,
            srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
            tree: [],
          },
        );
        const previousFoundation = foundationReplies.get(
          designFoundationKey(workspaceId, "home.html", requestedSourceVersion),
        );
        if (previousFoundation) {
          publishFoundation(
            designFoundationKey(workspaceId, "home.html", nextSourceVersion),
            {
              ...previousFoundation,
              summary: {
                ...previousFoundation.summary,
                revision: `harness:${nextSourceVersion}`,
              },
              foundation: {
                ...previousFoundation.foundation,
                revision: `harness:${nextSourceVersion}`,
              },
            },
          );
        }
        currentWorkspaceSnapshot = nextWorkspaceSnapshot;
        // Model the real worktree watcher seeing the file before this bridge
        // reply reaches updateDesignNodeStylesCached.
        applyDesignWorkspaceRefreshVersion(workspaceId, 1);
        await new Promise((resolve) =>
          window.setTimeout(
            resolve,
            (window as Window & { __zerosHarnessStyleDelay?: number })
              .__zerosHarnessStyleDelay ?? 50,
          ),
        );
        designShortcutOperations.push("style:end");
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            mutation: {
              changed: true,
              frame: {
                ...nextWorkspaceSnapshot.frames[0]!,
                source: currentHomeSource,
                srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
                tree: [],
              },
              lint: nextWorkspaceSnapshot.lint,
            },
            snapshot: nextWorkspaceSnapshot,
            foundationRevision: {
              before: `harness:${requestedSourceVersion}`,
              after: `harness:${nextSourceVersion}`,
            },
          },
        };
      }
      if (message.op === "design.transaction.apply") {
        await (window as Window & {
          __zerosHarnessDesignTransactionGate?: Promise<void>;
        }).__zerosHarnessDesignTransactionGate;
        const transaction = message.params?.transaction as
          | {
              transactionId?: string;
              documentId?: string;
              baseRevision?: string;
              operations?: Array<{
                operationId?: string;
                type?: string;
                nodeId?: string;
                duplicateNodeId?: string;
                parentId?: string;
                beforeId?: string | null;
                text?: string;
                attribute?: string;
                value?: string | null;
                html?: string;
                mode?: string;
                styles?: Record<string, string>;
                file?: string;
                name?: string;
                theme?: string | null;
                keyframes?: DesignKeyframeInput[];
                frame?: string;
                geometry?: {
                  x: number;
                  y: number;
                  width: number;
                  height: number;
                  z: number;
                };
              }>;
            }
          | undefined;
        if (transaction?.operations?.length && transaction.operations.every((operation) => operation.type === "token.set")) {
          const frameFile = String(message.params?.frame ?? "");
          const currentFrame = currentWorkspaceSnapshot.frames.find((frame) => frame.file === frameFile)!;
          const key = designFoundationKey(workspaceId, frameFile, currentFrame.sourceVersion);
          const previous = foundationReplies.get(key)!;
          if (transaction.documentId !== previous.summary.documentId || transaction.baseRevision !== previous.summary.revision)
            throw new Error("The token transaction document or revision is stale.");
          const tokens = structuredClone(currentWorkspaceSnapshot.tokens);
          for (const operation of transaction.operations) {
            let token = tokens.find((candidate) => candidate.name === operation.name);
            if (!token) {
              token = {
                name: operation.name!, syntax: "*", inherits: true,
                initialValue: operation.value ?? "", value: "", themeValues: {},
                usageCount: 0, line: tokens.length + 1,
              };
              tokens.push(token);
            }
            if (operation.theme) {
              if (operation.value === null) delete token.themeValues[operation.theme];
              else token.themeValues[operation.theme] = operation.value!;
            } else token.value = operation.value ?? "";
          }
          const revision = `harness:tokens:${transaction.transactionId}`;
          currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, tokens, tokenSourceVersion: revision };
          publishFoundation(key, {
            ...previous,
            summary: { ...previous.summary, revision },
            foundation: { ...previous.foundation, revision },
          });
          return {
            type: "WORKSPACE_RESPONSE",
            result: {
              result: {
                revision,
                receipt: {
                  status: "applied", transactionId: transaction.transactionId,
                  documentId: transaction.documentId, beforeRevision: transaction.baseRevision,
                  afterRevision: revision,
                  appliedOperationIds: transaction.operations.map((operation) => operation.operationId),
                  skippedOperationIds: [],
                },
              },
              snapshot: currentWorkspaceSnapshot,
            },
          };
        }
        // Mirror the adapter: storage cannot hold out-of-range frame geometry.
        for (const operation of transaction?.operations ?? []) {
          const invalid =
            operation.type === "frame.set-geometry" && operation.geometry
              ? designFrameGeometryError(operation.geometry)
              : null;
          if (invalid) throw new Error(invalid);
        }
        const textOperation = transaction?.operations?.find(
          (operation) => operation.type === "node.set-text",
        );
        if (textOperation && textCommitBarrier) { heldTextCommits++; await textCommitBarrier; }
        if (
          textOperation ||
          transaction?.operations?.some(
            (operation) =>
              operation.type === "node.set-styles" ||
              operation.type === "node.set-attribute" ||
              operation.type === "node.set-html" ||
              operation.type === "node.duplicate" ||
              operation.type === "node.delete" ||
              operation.type === "frame.set-geometry",
          )
        ) {
          const frameFile = String(message.params?.frame ?? "");
          const renameFailure = window as Window & { __zerosHarnessFailLayerRename?: boolean };
          if (renameFailure.__zerosHarnessFailLayerRename && transaction?.operations?.some(operation => operation.type === "node.set-attribute")) {
            renameFailure.__zerosHarnessFailLayerRename = false;
            throw new Error("The layer source changed before rename.");
          }
          const currentFrame = currentWorkspaceSnapshot.frames.find(
            (frame) => frame.file === frameFile,
          );
          if (!currentFrame) {
            throw new Error("The text transaction target is unavailable.");
          }
          const beforeRevision = `harness:${currentFrame.sourceVersion}`;
          if (
            transaction?.documentId !== `harness:${frameFile}` ||
            transaction.baseRevision !== beforeRevision
          ) {
            throw new Error("The transaction document or revision is stale.");
          }
          foundationControl.transactions.push({
            frame: frameFile,
            documentId: transaction.documentId,
            baseRevision: transaction.baseRevision,
            nodeIds: (transaction.operations ?? []).flatMap((operation) =>
              operation.nodeId ? [operation.nodeId] : [],
            ),
          });
          let transactionSource = frameFile === "home.html" ? currentHomeSource : frameFile === "pricing.html" ? currentPricingSource : performanceSources.get(frameFile)!;
          for (const operation of transaction?.operations ?? []) {
            if (operation.type === "node.duplicate" && operation.nodeId && operation.duplicateNodeId)
              transactionSource = mutateDesignNodeDuplicateSource(transactionSource, operation.nodeId, operation.duplicateNodeId);
            if (operation.type === "node.delete" && operation.nodeId)
              transactionSource = mutateDesignNodeDeleteSource(transactionSource, operation.nodeId);
            if (
              operation.type === "keyframes.set" &&
              operation.file === frameFile &&
              operation.name &&
              operation.keyframes
            ) {
              transactionSource = mutateDesignKeyframes(
                transactionSource,
                { name: operation.name, keyframes: operation.keyframes },
                operation.file,
              );
            }
          }
          const parsed = new DOMParser().parseFromString(
            transactionSource,
            "text/html",
          );
          if (textOperation?.nodeId) {
            const target = parsed.querySelector<HTMLElement>(
              `[data-oid="${CSS.escape(textOperation.nodeId)}"]`,
            );
            if (!target)
              throw new Error("The text transaction node is unavailable.");
            target.textContent = String(textOperation.text ?? "");
          }
          for (const operation of transaction?.operations ?? []) {
            if (operation.type === "node.set-html" && operation.nodeId) {
              const target =
                operation.nodeId === DESIGN_RUNTIME_DOCUMENT_BODY_ID
                  ? parsed.body
                  : parsed.querySelector<HTMLElement>(
                      `[data-oid="${CSS.escape(operation.nodeId)}"]`,
                    );
              if (!target)
                throw new Error("The insertion target is unavailable.");
              if (operation.mode === "append")
                target.insertAdjacentHTML("beforeend", operation.html ?? "");
              else target.innerHTML = operation.html ?? "";
            }
            if (operation.type === "node.set-attribute" && operation.nodeId && operation.attribute) {
              const target = parsed.querySelector(`[data-oid="${CSS.escape(operation.nodeId)}"]`);
              if (!target) throw new Error("The rename target is unavailable.");
              if (operation.value === null) target.removeAttribute(operation.attribute);
              else target.setAttribute(operation.attribute, operation.value ?? "");
            }
            if (
              operation.type === "node.move" &&
              operation.nodeId &&
              operation.parentId
            ) {
              const find = (id: string) =>
                id === DESIGN_RUNTIME_DOCUMENT_BODY_ID
                  ? parsed.body
                  : parsed.querySelector(`[data-oid="${CSS.escape(id)}"]`);
              const target = find(operation.nodeId);
              const parent = find(operation.parentId);
              if (!target || !parent)
                throw new Error("Missing layer move target");
              parent.insertBefore(
                target,
                operation.beforeId ? find(operation.beforeId) : null,
              );
            }
            if (operation.type !== "node.set-styles" || !operation.nodeId)
              continue;
            const target =
              operation.nodeId === DESIGN_RUNTIME_DOCUMENT_BODY_ID
                ? parsed.body
                : parsed.querySelector<HTMLElement>(
                    `[data-oid="${CSS.escape(operation.nodeId)}"]`,
                  );
            if (!target)
              throw new Error("The style transaction node is unavailable.");
            for (const [property, value] of Object.entries(
              operation.styles ?? {},
            )) {
              target.style.setProperty(property, value ?? "");
            }
          }
          const savedSource = transaction?.operations?.some((operation) => operation.type !== "frame.set-geometry")
            ? `<!doctype html>${parsed.documentElement.outerHTML}` : transactionSource;
          if (frameFile === "home.html") currentHomeSource = savedSource;
          else if (frameFile === "pricing.html") currentPricingSource = savedSource;
          else performanceSources.set(frameFile, savedSource);
          textTransactionCounter += 1;
          const nextSourceVersion = textTransactionCounter
            .toString(16)
            .padStart(24, "b")
            .slice(-24);
          const nextWorkspaceSnapshot = {
            ...currentWorkspaceSnapshot,
            frames: currentWorkspaceSnapshot.frames.map((frame) =>
              frame.file === frameFile
                ? {
                    ...frame,
                    ...transaction?.operations?.find(
                      (operation) =>
                        operation.type === "frame.set-geometry" &&
                        operation.frame === frame.file,
                    )?.geometry,
                    sourceVersion: nextSourceVersion,
                    modifiedAt: frame.modifiedAt + 1,
                  }
                : frame,
            ),
            lint: { ...currentWorkspaceSnapshot.lint, violations: [] },
          };
          const nextFrame = nextWorkspaceSnapshot.frames.find(
            (frame) => frame.file === frameFile,
          )!;
          if (transaction?.operations?.some((operation) => operation.type === "frame.set-geometry")) {
            const requests = ((window as typeof window & { __zerosHarnessCanvasUpdates?: unknown[] }).__zerosHarnessCanvasUpdates ??= []);
            requests.push({ frame: frameFile, x: nextFrame.x, y: nextFrame.y, w: nextFrame.width, h: nextFrame.height, z: nextFrame.z });
          }
          designFrameDocumentCache.setData(
            designFrameDocumentKey(workspaceId, frameFile, nextSourceVersion),
            {
              ...nextFrame,
              source: savedSource,
              srcDoc: withDesignRuntime(savedSource, nextSourceVersion),
              tree: [],
            },
          );
          const previousFoundation = foundationReplies.get(
            designFoundationKey(
              workspaceId,
              frameFile,
              currentFrame.sourceVersion,
            ),
          );
          if (previousFoundation) {
            publishFoundation(
              designFoundationKey(workspaceId, frameFile, nextSourceVersion),
              {
                ...previousFoundation,
                summary: {
                  ...previousFoundation.summary,
                  revision: `harness:${nextSourceVersion}`,
                },
                foundation: {
                  ...previousFoundation.foundation,
                  revision: `harness:${nextSourceVersion}`,
                  ...(frameMotionHarness ? {
                    keyframes: readDesignKeyframes({ [frameFile]: currentHomeSource }),
                  } : {}),
                },
              },
            );
          }
          currentWorkspaceSnapshot = nextWorkspaceSnapshot;
          applyDesignWorkspaceRefreshVersion(
            workspaceId,
            10 + textTransactionCounter,
          );
          const transactionGate = window as typeof window & {
            __zerosHarnessHoldTransactionReply?: boolean;
            __zerosHarnessReleaseTransaction?: () => void;
          };
          if (transactionGate.__zerosHarnessHoldTransactionReply) {
            transactionGate.__zerosHarnessHoldTransactionReply = false;
            await new Promise<void>((resolve) => {
              transactionGate.__zerosHarnessReleaseTransaction = resolve;
            });
          }
          await new Promise((resolve) => window.setTimeout(resolve, 50));
          const afterRevision = `harness:${nextSourceVersion}`;
          return {
            type: "WORKSPACE_RESPONSE",
            result: {
              result: {
                revision: afterRevision,
                receipt: {
                  status: "applied",
                  transactionId: transaction?.transactionId ?? "harness:text",
                  documentId: transaction?.documentId ?? "harness:home.html",
                  beforeRevision,
                  afterRevision,
                  appliedOperationIds: (transaction?.operations ?? []).map(
                    (operation) => operation.operationId ?? "harness:operation",
                  ),
                  skippedOperationIds: [],
                },
              },
              snapshot: nextWorkspaceSnapshot,
            },
          };
        }
      }
      if (message.op === "design.node.text") {
        const nextSourceVersion = "ffffffffffffffffffffffff";
        const previousSourceVersion = String(
          message.params?.sourceVersion ?? "",
        );
        const nextWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map((frame) =>
            frame.file === "home.html"
              ? {
                  ...frame,
                  sourceVersion: nextSourceVersion,
                  modifiedAt: frame.modifiedAt + 1,
                }
              : frame,
          ),
          lint: { ...currentWorkspaceSnapshot.lint, violations: [] },
        };
        designFrameDocumentCache.setData(
          designFrameDocumentKey(workspaceId, "home.html", nextSourceVersion),
          {
            ...nextWorkspaceSnapshot.frames[0]!,
            source: currentHomeSource,
            srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
            tree: [],
          },
        );
        const previousFoundation = foundationReplies.get(
          designFoundationKey(workspaceId, "home.html", previousSourceVersion),
        );
        if (previousFoundation) {
          publishFoundation(
            designFoundationKey(workspaceId, "home.html", nextSourceVersion),
            {
              ...previousFoundation,
              summary: {
                ...previousFoundation.summary,
                revision: `harness:${nextSourceVersion}`,
              },
              foundation: {
                ...previousFoundation.foundation,
                revision: `harness:${nextSourceVersion}`,
              },
            },
          );
        }
        currentWorkspaceSnapshot = nextWorkspaceSnapshot;
        applyDesignWorkspaceRefreshVersion(workspaceId, 2);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            mutation: {
              changed: true,
              frame: {
                ...nextWorkspaceSnapshot.frames[0]!,
                source: currentHomeSource,
                srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
                tree: [],
              },
              lint: nextWorkspaceSnapshot.lint,
            },
            snapshot: nextWorkspaceSnapshot,
            foundationRevision: {
              before: `harness:${previousSourceVersion}`,
              after: `harness:${nextSourceVersion}`,
            },
          },
        };
      }
      if (message.op === "design.node.html") {
        const frameFile = String(message.params?.frame ?? "");
        const parentNodeId = String(message.params?.nodeId ?? "");
        const html = String(message.params?.html ?? "");
        const previousSourceVersion = String(
          message.params?.sourceVersion ?? "",
        );
        if (
          frameFile !== "home.html" ||
          parentNodeId !== "home-main" ||
          message.params?.mode !== "append" ||
          !html.includes("data-oid=")
        ) {
          throw new Error("The harness only appends text to home-main.");
        }
        appendedTextCounter += 1;
        const nextSourceVersion = appendedTextCounter
          .toString(16)
          .padStart(24, "d")
          .slice(-24);
        currentHomeSource = currentHomeSource.replace(
          /<\/main>/i,
          `${html}</main>`,
        );
        const nextWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map((frame) =>
            frame.file === frameFile
              ? {
                  ...frame,
                  nodeCount: frame.nodeCount + 1,
                  sourceVersion: nextSourceVersion,
                  modifiedAt: frame.modifiedAt + 1,
                }
              : frame,
          ),
        };
        const nextFrame = nextWorkspaceSnapshot.frames.find(
          (frame) => frame.file === frameFile,
        )!;
        designFrameDocumentCache.setData(
          designFrameDocumentKey(workspaceId, frameFile, nextSourceVersion),
          {
            ...nextFrame,
            source: currentHomeSource,
            srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
            tree: [],
          },
        );
        const previousFoundation = foundationReplies.get(
          designFoundationKey(workspaceId, frameFile, previousSourceVersion),
        );
        if (previousFoundation) {
          publishFoundation(
            designFoundationKey(workspaceId, frameFile, nextSourceVersion),
            {
              ...previousFoundation,
              summary: {
                ...previousFoundation.summary,
                revision: `harness:${nextSourceVersion}`,
              },
              foundation: {
                ...previousFoundation.foundation,
                revision: `harness:${nextSourceVersion}`,
              },
            },
          );
        }
        currentWorkspaceSnapshot = nextWorkspaceSnapshot;
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            mutation: {
              changed: true,
              frame: {
                ...nextFrame,
                source: currentHomeSource,
                srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
                tree: [],
              },
              lint: nextWorkspaceSnapshot.lint,
            },
            snapshot: nextWorkspaceSnapshot,
            foundationRevision: {
              before: `harness:${previousSourceVersion}`,
              after: `harness:${nextSourceVersion}`,
            },
          },
        };
      }
      if (message.op === "design.frame.rename") {
        const file = String(message.params?.frame ?? "");
        const frame = currentWorkspaceSnapshot.frames.find(candidate => candidate.file === file);
        if (!frame) throw new Error("The frame rename target is unavailable.");
        const renamed = { ...frame, title: String(message.params?.title ?? "").trim() };
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.map(candidate => candidate.file === file ? renamed : candidate),
        };
        return { type: "WORKSPACE_RESPONSE", result: { frame: renamed, snapshot: currentWorkspaceSnapshot } };
      }
      if (
        message.op === "design.frame.create" &&
        message.params?.kind === "text"
      ) {
        looseTextFrameCounter += 1;
        const encode = (value: unknown) =>
          String(value ?? "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
        const file = `canvas-text-${looseTextFrameCounter}.html`;
        const sourceVersion = looseTextFrameCounter
          .toString(16)
          .padStart(24, "e")
          .slice(-24);
        const nodeId = String(message.params.textNodeId ?? "canvas-text");
        const text = String(message.params.text ?? "");
        const title = String(message.params.title ?? "Text");
        const frame = {
          file,
          title,
          kind: "text" as const,
          width: Number(message.params.w ?? 1),
          height: Number(message.params.h ?? 1),
          x: Number(message.params.x ?? 0),
          y: Number(message.params.y ?? 0),
          z: Number(message.params.z ?? currentWorkspaceSnapshot.frames.length),
          nodeCount: 1,
          modifiedAt: Date.now(),
          sourceVersion,
        };
        const source = `<!doctype html><html><head><meta name="zeros-frame" content="width=${frame.width},height=${frame.height},kind=text,title=${encode(title)}"><style>*{box-sizing:border-box}html,body{width:100%;height:100%;min-height:0;margin:0;background:transparent;overflow:visible}body{font:16px/1.5 ui-sans-serif,system-ui,sans-serif;color:black}body>[data-oid]{${message.params.textFixedSize === true ? "width:100%;min-height:100%;" : "width:max-content;max-width:none;"}margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style><title>${encode(title)}</title></head><body><div data-oid="${encode(nodeId)}">${encode(text)}</div></body></html>`;
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: [...currentWorkspaceSnapshot.frames, frame],
        };
        designFrameDocumentCache.setData(
          designFrameDocumentKey(workspaceId, file, sourceVersion),
          {
            ...frame,
            source,
            srcDoc: withDesignRuntime(source, sourceVersion),
            tree: [],
          },
        );
        publishFoundation(
          designFoundationKey(workspaceId, file, sourceVersion),
          {
            summary: {
              apiVersion: 1,
              documentId: `harness:${file}`,
              revision: `harness:${sourceVersion}`,
              entryFile: file,
              fileCount: 1,
              nodeCount: 1,
              valid: true,
              diagnostics: [],
              lastValidRevision: `harness:${sourceVersion}`,
              history: {
                canUndo: false,
                canRedo: false,
                undoDepth: 0,
                redoDepth: 0,
                retainedBytes: 0,
                retainedReceiptBytes: 0,
                revision: `harness:${sourceVersion}`,
                lastReconciliationReason: null,
              },
            },
            foundation: {
              documentId: `harness:${file}`,
              revision: `harness:${sourceVersion}`,
              manifest: {
                schemaVersion: 1,
                parameters: [],
                variants: [],
                components: [],
              },
              keyframes: [],
            },
          } as never,
        );
        return {
          type: "WORKSPACE_RESPONSE",
          result: { frame, snapshot: currentWorkspaceSnapshot },
        };
      }
      if (
        message.op === "design.frame.create" &&
        message.params?.kind !== "text"
      ) {
        // Mirrors the engine seed: one border-box frame root, placed where the
        // canvas drew it or in the next three-column slot.
        htmlFrameCounter += 1;
        const file = `frame-${htmlFrameCounter}.html`;
        const sourceVersion = htmlFrameCounter
          .toString(16)
          .padStart(24, "f")
          .slice(-24);
        const index = currentWorkspaceSnapshot.frames.length;
        const drawn = message.params?.w !== undefined;
        const frame = {
          file,
          title: String(message.params?.title ?? "Frame"),
          ...(measureContinuityHarness ? { frameId: `created_${htmlFrameCounter}`, pageId: "main" } : {}),
          kind: "frame" as const,
          width: drawn ? Number(message.params!.w) : 1440,
          height: drawn ? Number(message.params!.h) : 900,
          x: drawn ? Number(message.params!.x) : (index % 3) * 1560,
          y: drawn ? Number(message.params!.y) : Math.floor(index / 3) * 1020,
          z: drawn ? Number(message.params!.z) : index,
          nodeCount: 1,
          layerCount: 0,
          modifiedAt: Date.now(),
          sourceVersion,
        };
        const source = `<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}</style></head><body><main data-oid="f-${htmlFrameCounter}-main" data-zeros-frame-root style="display:block; position:relative; width:100%; height:100vh; box-sizing:border-box; background-color:white; opacity:1;"></main></body></html>`;
        if (measureContinuityHarness) performanceSources.set(file, source);
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: [...currentWorkspaceSnapshot.frames, frame],
        };
        if (measureContinuityHarness) currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          pages: [{ id: "main", title: "Design", folder: "",
            frameFiles: currentWorkspaceSnapshot.frames.map(candidate => candidate.file),
            frameIds: currentWorkspaceSnapshot.frames.flatMap(candidate => candidate.frameId ? [candidate.frameId] : []) }],
        };
        designFrameDocumentCache.setData(
          designFrameDocumentKey(workspaceId, file, sourceVersion),
          {
            ...frame,
            source,
            srcDoc: withDesignRuntime(source, sourceVersion),
            tree: [],
          },
        );
        return {
          type: "WORKSPACE_RESPONSE",
          result: { frame, snapshot: currentWorkspaceSnapshot },
        };
      }
      if (message.op === "design.foundation.open") {
        const frameFile = String(message.params?.frame ?? "");
        foundationControl.reads.push({
          frame: frameFile,
          sourceVersion: currentWorkspaceSnapshot.frames.find(
            (frame) => frame.file === frameFile,
          )?.sourceVersion,
        });
        await foundationReadGate;
        const sourceVersion = currentWorkspaceSnapshot.frames.find(
          (frame) => frame.file === frameFile,
        )?.sourceVersion;
        const foundation = sourceVersion
          ? foundationReplies.get(
              designFoundationKey(workspaceId, frameFile, sourceVersion),
            )
          : null;
        if (!foundation) {
          throw new Error("The harness foundation is unavailable.");
        }
        return { type: "WORKSPACE_RESPONSE", result: foundation };
      }
      if (message.op === "design.themes.update") {
        // Upsert one theme name, as the engine does; a new default clears the old one.
        const theme = message.params?.theme as { id: string; label: string; base?: boolean };
        designThemeUpdates.push(theme);
        const existing = currentWorkspaceSnapshot.themes ?? [];
        const named = (id: string, label: string, base: boolean) => ({ id, label, ...(base ? { base: true as const } : {}) });
        const themes = existing.some((entry) => entry.id === theme.id)
          ? existing.map((entry) =>
              entry.id === theme.id
                ? named(entry.id, theme.label, theme.base === true || entry.base === true)
                : named(entry.id, entry.label, theme.base !== true && entry.base === true))
          : [
              ...existing.map((entry) => named(entry.id, entry.label, theme.base !== true && entry.base === true)),
              named(theme.id, theme.label, theme.base === true),
            ];
        currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, themes };
        return { type: "WORKSPACE_RESPONSE", result: { themes, snapshot: currentWorkspaceSnapshot } };
      }
      if (message.op === "design.styles.refresh") {
        designStyleRefreshes += 1;
        return { type: "WORKSPACE_RESPONSE", result: { ok: true } };
      }
      if (message.op === "design.snapshot") {
        if ((window as unknown as { __zerosHarnessDesignSnapshotFailure?: boolean }).__zerosHarnessDesignSnapshotFailure)
          throw new Error("Design snapshot temporarily unavailable");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { snapshot: workbenchHarness || message.params?.workspaceId !== workspaceId ? { ...currentWorkspaceSnapshot, lint: { ...currentWorkspaceSnapshot.lint, workspacePath: workspaces.find((row) => row.id === message.params?.workspaceId)?.path ?? workspacePath } } : currentWorkspaceSnapshot },
        };
      }
      if (message.op === "design.frame") {
        const file = String(message.params?.frame ?? "");
        const frame = currentWorkspaceSnapshot.frames.find((item) => item.file === file);
        if (!frame) throw new Error("The harness frame is unavailable.");
        const retained = designFrameDocumentCache.peekSnapshot(designFrameDocumentKey(workspaceId, file, frame.sourceVersion)).data;
        const source = file === "home.html" ? currentHomeSource : file === "pricing.html" ? currentPricingSource : performanceSources.get(file) ?? retained?.source;
        if (!source) throw new Error("The harness frame source is unavailable.");
        return { type: "WORKSPACE_RESPONSE", result: { frame: { ...frame, source, srcDoc: withDesignRuntime(source, frame.sourceVersion), tree: [] } } };
      }
      if (message.op === "design.frame.delete") {
        const frameFile = String(message.params?.frame ?? "");
        const deleted = currentWorkspaceSnapshot.frames.find(
          (frame) => frame.file === frameFile,
        );
        if (!deleted) throw new Error(`Frame not found: ${frameFile}`);
        currentWorkspaceSnapshot = {
          ...currentWorkspaceSnapshot,
          frames: currentWorkspaceSnapshot.frames.filter(
            (frame) => frame.file !== frameFile,
          ),
        };
        frameDeletionUndo.push(deleted);
        frameDeletionRedo.length = 0;
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            deleted: { file: frameFile },
            snapshot: currentWorkspaceSnapshot,
          },
        };
      }
      if (
        message.op === "design.history.undo" ||
        message.op === "design.history.redo"
      ) {
        const direction = message.op.endsWith("undo") ? "undo" : "redo";
        designShortcutOperations.push(`${direction}:start`);
        const source =
          direction === "undo" ? frameDeletionUndo : frameDeletionRedo;
        const destination =
          direction === "undo" ? frameDeletionRedo : frameDeletionUndo;
        const deletedFrame = source.pop();
        let historySelection: string | null | undefined;
        if (deletedFrame) {
          if (direction === "undo") {
            currentWorkspaceSnapshot = {
              ...currentWorkspaceSnapshot,
              frames: [...currentWorkspaceSnapshot.frames, deletedFrame].sort(
                (left, right) => left.z - right.z,
              ),
            };
            historySelection = deletedFrame.file;
          } else {
            currentWorkspaceSnapshot = {
              ...currentWorkspaceSnapshot,
              frames: currentWorkspaceSnapshot.frames.filter(
                (frame) => frame.file !== deletedFrame.file,
              ),
            };
            historySelection = currentWorkspaceSnapshot.frames[0]?.file ?? null;
          }
          destination.push(deletedFrame);
        } else {
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        designShortcutOperations.push(`${direction}:end`);
        return {
          type: "WORKSPACE_RESPONSE",
          result: {
            result: null,
            snapshot: currentWorkspaceSnapshot,
            ...(historySelection !== undefined ? { historySelection } : {}),
          },
        };
      }
      if (message.op === "design.review.snapshot") {
        const scope = String(message.params?.scope ?? "uncommitted");
        const counts = { all: 1, uncommitted: reviewCommitted ? 0 : 1, staged: reviewStaged ? 1 : 0, unstaged: reviewStaged || reviewCommitted ? 0 : 1, proposals: 1 };
        const files = scope !== "proposals" && counts[scope as keyof typeof counts] > 0 ? [{ path: "Design/home.html", status: "modified", additions: 1, deletions: 1, binary: false }] : [];
        return { type: "WORKSPACE_RESPONSE", result: { directory: "Design", directoryId: "harness-review", indexFingerprint: reviewStaged ? "b".repeat(64) : "a".repeat(64), scope, counts, files, proposals: scope === "proposals" ? [reviewProposal()] : [], nextOffset: null, conflict: false } };
      }
      if (message.op === "design.review.file") return { type: "WORKSPACE_RESPONSE", result: { path: "Design/home.html", patch: "--- Before\n+++ After\n@@ -1 +1 @@\n-<h1>Draft</h1>\n+<h1>Refined</h1>", truncated: false, binary: false } };
      if (message.op === "design.review.proposal") return { type: "WORKSPACE_RESPONSE", result: { captureAvailable: true, evidence: reviewCaptured ? evidence() : null, proposal: reviewProposal(), currentRevision: "harness-review-base", applicable: reviewProposalStatus === "proposed", reason: reviewProposalStatus === "proposed" ? null : "This proposal has already been resolved.", patch: "--- Before\n+++ Proposed\n@@ -1 +1 @@\n-margin: 8px;\n+margin: 12px;", truncated: false, operations: [{ type: "node.set-styles", nodeId: "heading" }] } };
      if (message.op === "design.review.capture") { reviewCaptured = true; return { type: "WORKSPACE_RESPONSE", result: evidence() }; }
      if (message.op === "design.review.evidence") {
        const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=";
        return { type: "WORKSPACE_RESPONSE", result: { ...evidence(), before: png, after: png } };
      }
      if (message.op === "design.review.resolve") {
        const decision = String(message.params?.decision);
        reviewProposalStatus = decision === "accept" ? "committed" : "rejected";
        if (decision === "accept") { reviewStaged = false; reviewCommitted = false; }
        designShortcutOperations.push(`proposal:${decision}`);
        return { type: "WORKSPACE_RESPONSE", result: reviewProposal() };
      }
      if (message.op === "design.unstage") {
        reviewStaged = false;
        designShortcutOperations.push("unstage");
        return { type: "WORKSPACE_RESPONSE", result: { ok: true } };
      }
      if (message.op === "design.stage") {
        reviewStaged = true;
        designShortcutOperations.push("stage:start");
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        designShortcutOperations.push("stage:end");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { ok: true },
        };
      }
      if (message.op === "design.save") {
        designShortcutOperations.push("save:start");
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        designShortcutOperations.push("save:end");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { ok: true },
        };
      }
      if (message.op === "design.commit") {
        if ((window as unknown as { __zerosHarnessDesignCommitFailure?: boolean }).__zerosHarnessDesignCommitFailure)
          throw new Error("Staging changed after review. Refresh before committing.");
        reviewStaged = false; reviewCommitted = true;
        designShortcutOperations.push("commit");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { sha: "a".repeat(40), branch: workspace.branch },
        };
      }
      if (message.op === "design.runtime.audit") {
        const frame = String(message.params?.frame ?? "");
        const sourceVersion = String(message.params?.sourceVersion ?? "");
        const runtimeWarnings = Array.isArray(message.params?.warnings)
          ? message.params.warnings
              .filter(
                (
                  warning,
                ): warning is {
                  ruleId: "contrast" | "overflow" | "spacing-scale";
                  oid: string;
                  message: string;
                  fix: string;
                } =>
                  Boolean(
                    warning &&
                    typeof warning === "object" &&
                    typeof (warning as { ruleId?: unknown }).ruleId ===
                      "string" &&
                    (warning as { ruleId?: unknown }).ruleId ===
                      "spacing-scale" &&
                    typeof (warning as { oid?: unknown }).oid === "string" &&
                    typeof (warning as { message?: unknown }).message ===
                      "string" &&
                    typeof (warning as { fix?: unknown }).fix === "string",
                  ),
              )
              .map((warning, index) => ({
                ...warning,
                severity: "warning" as const,
                file: frame,
                line: index + 1,
                column: 1,
              }))
          : [];
        const warnings =
          runtimeWarnings.length > 0
            ? runtimeWarnings
            : [
                {
                  ruleId: "spacing-scale" as const,
                  severity: "warning" as const,
                  message: "Spacing needs review on the current frame.",
                  file: frame,
                  line: 1,
                  column: 1,
                  oid: `${frame.replace(/\.html$/i, "")}-main`,
                  fix: "Use a design spacing token or a multiple of 4px.",
                },
              ];
        if (
          currentWorkspaceSnapshot.frames.some(
            (candidate) =>
              candidate.file === frame &&
              candidate.sourceVersion === sourceVersion,
          )
        ) {
          currentWorkspaceSnapshot = {
            ...currentWorkspaceSnapshot,
            lint: {
              ...currentWorkspaceSnapshot.lint,
              violations: [
                ...currentWorkspaceSnapshot.lint.violations.filter(
                  (violation) => violation.file !== frame,
                ),
                ...warnings,
              ],
            },
          };
        }
        return { type: "WORKSPACE_RESPONSE", result: { ok: true,
          ...(lazyPreparationHarness ? { sourceVersion, violations: warnings } : {}) } };
      }
      return { type: "WORKSPACE_RESPONSE", result: { ok: true } };
    }),
  } as never);

  (
    window as Window & {
      __zerosHarnessCommitStyleGeneration?: () => Promise<string>;
    }
  ).__zerosHarnessCommitStyleGeneration = async () => {
    const frame = designWorkspaceSnapshotCache
      .getSnapshot(workspaceId)
      .data?.frames.find((candidate) => candidate.file === "home.html");
    if (!frame) throw new Error("The style harness frame is unavailable.");
    await updateDesignNodeStylesCached(workspaceId, {
      frame: "home.html",
      nodeId: "home-heading",
      sourceVersion: frame.sourceVersion,
      styles: { width: "901px" },
    });
    const committedFrame = designWorkspaceSnapshotCache
      .getSnapshot(workspaceId)
      .data?.frames.find((candidate) => candidate.file === "home.html");
    if (!committedFrame) {
      throw new Error("The committed style harness frame is unavailable.");
    }
    return committedFrame.sourceVersion;
  };
  (
    window as Window & {
      __zerosHarnessCommitStructuralGeneration?: () => Promise<string>;
    }
  ).__zerosHarnessCommitStructuralGeneration = async () => {
    const frame = designWorkspaceSnapshotCache
      .getSnapshot(workspaceId)
      .data?.frames.find((candidate) => candidate.file === "home.html");
    if (!frame) throw new Error("The structural harness frame is unavailable.");
    await captureDesignRuntimeScreenshot(
      workspaceId,
      workspacePath,
      frame.file,
      frame.sourceVersion,
      null,
      0.5,
    );
    const nextSourceVersion = "ffffffffffffffffffffffff";
    await setDesignNodeTextCached(workspaceId, {
      frame: frame.file,
      nodeId: "home-heading",
      sourceVersion: frame.sourceVersion,
      text: "Make the next move unmistakable.",
    });
    return nextSourceVersion;
  };

  function Harness() {
    const [ownerId, setOwnerId] = React.useState(workspaceId);
    const [rootPath, setRootPath] = React.useState(workspacePath);
    const [surfaceActive, setSurfaceActive] = React.useState(true);
    React.useLayoutEffect(() => {
      const controls = {
        // Use the stores that seeded this rendered fixture. A direct browser
        // import after Vite HMR can create a second, unobserved module instance.
        ui: useDesignWorkspaceUiStore,
        snapshots: designWorkspaceSnapshotCache,
        documents: designFrameDocumentCache,
        documentKey: designFrameDocumentKey,
        resources: designRendererResources,
        previews: designFramePreviews,
        measurement: measureContinuityHarness ? {
          engineDelayMs, retained: retainedContinuityHarness, requests: delayedRequests, runtime: useDesignRuntimeStore, commits: profilerCommits,
          snapshot: () => currentWorkspaceSnapshot,
          refresh: (id: string) => designWorkspaceSnapshotCache.invalidate(id),
          editing: hasPendingDesignEdits,
          hold(op: string) {
            if (!delayedOperations.has(op)) throw new Error("Only measured fixture operations can be held.");
            if (measurementHolds.has(op)) return;
            let release!: () => void;
            const promise = new Promise<void>(resolve => { release = resolve; });
            measurementHolds.set(op, { promise, release });
          },
          release(op: string) { measurementHolds.get(op)?.release(); measurementHolds.delete(op); },
        } : undefined,
        textCommit: { hold: holdTextCommit, release: () => releaseTextCommit?.(), started: () => heldTextCommits },
        lazy: lazyPreparationHarness ? {
          calls: preparationCalls,
          operations: workbenchOperations,
          hold: holdPreparation,
          release: () => releasePreparation?.(),
          refresh: () => designWorkspaceSnapshotCache.invalidate(workspaceId),
        } : undefined,
        frames(frames: DesignWorkspaceSnapshotWire["frames"]) {
          if (frames.length > 256) throw new Error("Performance fixtures keep the supported 256-frame bound.");
          for (const frame of frames) {
            if (frame.file !== "home.html" && frame.file !== "pricing.html")
              performanceSources.set(frame.file, currentHomeSource);
          }
          currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, frames };
          designWorkspaceSnapshotCache.setData(workspaceId, currentWorkspaceSnapshot);
        },
        protocol(capability: string | null) {
          currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, protocolCapability: capability };
          designWorkspaceSnapshotCache.setData(workspaceId, currentWorkspaceSnapshot);
        },
        directory(directoryId: string, directory: string) {
          currentWorkspaceSnapshot = { ...currentWorkspaceSnapshot, directoryId, directory };
          designWorkspaceSnapshotCache.setData(workspaceId, currentWorkspaceSnapshot);
        },
        owner(id: string) {
          retainMeasurementScope(id === workspaceId ? workspacePath : `${workspacePath}-${id}`);
          if (id !== workspaceId) {
            const ownerPath = `${workspacePath}-${id}`;
            if (!workspaces.some((row) => row.id === id)) workspaces.push({ ...workspace, id, path: ownerPath });
            if (lazyPreparationHarness) {
              if (!measureContinuityHarness || !designWorkspaceSnapshotCache.peekSnapshot(id).data) designWorkspaceSnapshotCache.forget(id);
            } else designWorkspaceSnapshotCache.setData(id, {
              ...structuredClone(currentWorkspaceSnapshot),
              lint: { ...currentWorkspaceSnapshot.lint, workspacePath: ownerPath },
            });
          }
          setOwnerId(id);
        },
        root(replaced: boolean) { setRootPath(replaced ? `${workspacePath}-replacement` : workspacePath); },
        active: setSurfaceActive,
      };
      const target = window as Window & { __zerosHarnessDesignSurface?: typeof controls };
      target.__zerosHarnessDesignSurface = controls;
      return () => { delete target.__zerosHarnessDesignSurface; };
    }, []);
    const visibleWorkspace = ownerId === workspaceId && rootPath === workspacePath ? workspace :
      { ...workspace, id: ownerId, path: ownerId === workspaceId ? rootPath : `${rootPath}-${ownerId}` };
    const designColumn = RetainedDesignDeck
      ? <RetainedDesignDeck workspace={visibleWorkspace} folder={visibleWorkspace.path} active={surfaceActive} />
      : <DesignWorkspaceColumn workspace={visibleWorkspace} folder={visibleWorkspace.path} surfaceActive={surfaceActive} />;
    return (
      <ActionsCtx.Provider value={new Proxy({
        setRetainedChatIds: () => {}, getSession: () => undefined, getCloseActivity: () => ({ running: false, queuedCount: 0 }),
        hydrateChat: async () => {}, listAgents: async () => [],
      }, { get: (target, key) => key in target ? target[key as keyof typeof target] : () => Promise.resolve() }) as unknown as import("../features/agent/sessions-context").SessionsCtx}>
      <TooltipProvider delayDuration={300} skipDelayDuration={0}>
        <main data-harness-design-root={rootPath} data-harness-design-owner={measureContinuityHarness ? ownerId : undefined}
          data-harness-design-active={measureContinuityHarness ? String(surfaceActive) : undefined}
          {...(measureContinuityHarness && !surfaceActive ? { inert: "" as const, "aria-hidden": true, style: { visibility: "hidden" as const } } : {})}
          className="bg-bg1 relative flex h-screen min-h-0 overflow-hidden">
          {WorkbenchPane && ConversationPane ? <><ConversationPane workspace={workspace} /><WorkbenchPane surfaceActive onToggleWorkbench={() => {}} /></> : <>
          {ReferenceFixture && <ReferenceFixture folder={workspacePath} />}
          {profileContinuityHarness ? <React.Profiler id="DesignWorkspaceColumn" onRender={(id, phase, actualDuration, baseDuration, startTime, commitTime) => {
            profilerCommits.push({ id, phase, actualDuration, baseDuration, startTime, commitTime });
            if (profilerCommits.length > 512) profilerCommits.shift();
          }}>{designColumn}</React.Profiler> : designColumn}
          </>}
        </main>
        <Toaster />
      </TooltipProvider>
      </ActionsCtx.Provider>
    );
  }

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  );
}

void main();
