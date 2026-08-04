// Standalone development harness — NOT part of the shipped app.
//
// Serves the real DesignWorkspaceColumn with a warm aggregate snapshot so
// browser QA can inspect layout and local interactions without an Electron
// preload or engine. Mutations intentionally remain disabled by the absent
// bridge; rendering, selection memory, code view, and viewport controls are the
// production components.

import "../styles/zeros-tokens.css";
import "../styles/semantic-tokens.css";
import "../styles/globals.css";

import { DESIGN_RUNTIME_SOURCE } from "@zeros/core/design-runtime";

const HOME_SOURCE_VERSION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PRICING_SOURCE_VERSION = "bbbbbbbbbbbbbbbbbbbbbbbb";

function withDesignRuntime(source: string, sourceVersion: string): string {
  const runtime =
    `<script>window.__zerosDesignSourceVersion=${JSON.stringify(sourceVersion)};` +
    `${DESIGN_RUNTIME_SOURCE}</script>`;
  return source.replace(/<\/body>/i, () => `${runtime}</body>`);
}

const homeSource = `<!doctype html>
<html data-oid="home-html">
  <head>
    <style>
      * { box-sizing: border-box; }
      body { margin: 0; background: white; color: black; font-family: ui-sans-serif, system-ui, sans-serif; }
      main { min-height: 100vh; display: flex; flex-direction: column; justify-content: space-between; padding: 72px; }
      nav { display: flex; align-items: center; justify-content: space-between; }
      .mark { font-weight: 700; letter-spacing: -0.04em; }
      .hero { display: flex; max-width: 900px; flex-direction: column; gap: 24px; }
      h1 { margin: 0; font-size: 88px; line-height: 0.95; letter-spacing: -0.06em; }
      p { max-width: 620px; margin: 0; color: dimgray; font-size: 24px; line-height: 1.5; }
      .button { width: fit-content; border-radius: 999px; background: black; color: white; padding: 16px 24px; }
      .harness-layer { display: none; }
    </style>
  </head>
  <body data-oid="home-body">
    <main data-oid="home-main">
      <nav data-oid="home-nav"><span data-oid="home-mark" class="mark">NORTH/ONE</span><span data-oid="home-season">Summer 2026</span></nav>
      <div data-oid="home-hero" class="hero">
        <h1 data-oid="home-heading">Make the next move unmistakable.</h1>
        <p data-oid="home-copy">A decisive launch surface for teams building products that deserve attention.</p>
        <span data-oid="home-action" class="button">Explore the system →</span>
        ${Array.from(
          { length: 48 },
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
      strong { font-size: 32px; }
      p { color: lightgray; line-height: 1.5; }
    </style>
  </head>
  <body data-oid="pricing-body">
    <main data-oid="pricing-main">
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
  const workspaceId = "ws_design_harness";
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
    createdAt: Date.now(),
    archivedAt: null,
    stashRef: null,
    prNumber: 42,
    prState: "ready" as const,
    prUrl: "https://github.com/example/north-one/pull/42",
    agentId: null,
    lastActiveAt: Date.now(),
  };
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
  const { createRoot } = await import("react-dom/client");
  const { TooltipProvider } = await import("./zeros/ui/primitives/tooltip");
  const { DesignWorkspaceColumn } =
    await import("./zeros/panels/design-workspace");
  const { DesignWorkspaceSidebar } =
    await import("./zeros/panels/design-workspace-sidebar");
  const { designWorkspaceSnapshotCache } =
    await import("./zeros/store/design-workspace-cache");
  const { useDesignWorkspaceUiStore } =
    await import("./zeros/store/design-workspace-ui");
  const { useDesignRuntimeStore } =
    await import("./zeros/store/design-runtime-store");
  const { setWorkspaceRowsForTesting } =
    await import("./zeros/store/use-projects");
  const { useWorkspaceStore } = await import("./zeros/store/store");

  setWorkspaceRowsForTesting(workspace.repoSlug, [workspace]);
  useWorkspaceStore.setState({
    activeChatId: null,
    newAgentFolder: workspacePath,
  });
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
        source: homeSource,
        srcDoc: withDesignRuntime(homeSource, HOME_SOURCE_VERSION),
        tree: [],
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
        source: pricingSource,
        srcDoc: withDesignRuntime(pricingSource, PRICING_SOURCE_VERSION),
        tree: [],
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
    ],
    tokenSourceVersion: "tokens-source-version-1",
    assets: [],
    lint: {
      workspacePath,
      checkedFiles: ["home.html", "pricing.html"],
      violations: reviewFindings,
      healedOids: 0,
    },
  });
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
      background: "transparent",
      border: "0px none var(--fg1)",
      borderRadius: "0px",
    },
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
                ...Array.from({ length: 48 }, (_, index) => ({
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
  useDesignWorkspaceUiStore
    .getState()
    .setSelection(workspaceId, "home.html", "home-heading");

  function Harness() {
    return (
      <TooltipProvider delayDuration={300} skipDelayDuration={0}>
        <main className="bg-bg1 flex h-screen min-h-0 overflow-hidden">
          <DesignWorkspaceSidebar surfaceActive />
          <DesignWorkspaceColumn
            workspace={workspace}
            folder={workspacePath}
            surfaceActive
            onToggleCol3={() => {}}
          />
        </main>
      </TooltipProvider>
    );
  }

  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <Harness />
    </React.StrictMode>,
  );
}

void main();
