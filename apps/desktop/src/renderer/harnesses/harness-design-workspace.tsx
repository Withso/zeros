// Standalone development harness — NOT part of the shipped app.
//
// Serves the real DesignWorkspaceColumn with a warm aggregate snapshot so
// browser QA can inspect layout and local interactions without an Electron
// preload or engine. Mutations intentionally remain disabled by the absent
// bridge; rendering, selection memory, code view, and viewport controls are the
// production components.

import "../../../../../styles/zeros-tokens.css";
import "../../../../../styles/semantic-tokens.css";
import "../../../../../styles/globals.css";

import { DESIGN_RUNTIME_SOURCE } from "@zeros/protocol/design-runtime";

const HOME_SOURCE_VERSION = "aaaaaaaaaaaaaaaaaaaaaaaa";
const PRICING_SOURCE_VERSION = "bbbbbbbbbbbbbbbbbbbbbbbb";
const HARNESS_LAYER_COUNT = new URLSearchParams(window.location.search).has(
  "denseLayers",
)
  ? 10_000
  : 48;

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
      .mark { margin-left: 2px; font-weight: 700; letter-spacing: -0.04em; }
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
  const { TooltipProvider } = await import("../shared/ui/primitives/tooltip");
  const { DesignWorkspaceColumn } =
    await import("../features/design-workspace/design-workspace");
  const { DesignWorkspaceSidebar } =
    await import("../features/design-workspace/design-workspace-sidebar");
  const {
    applyDesignWorkspaceRefreshVersion,
    designFoundationCache,
    designFoundationKey,
    designFrameDocumentCache,
    designFrameDocumentKey,
    designWorkspaceSnapshotCache,
    setDesignNodeTextCached,
    updateDesignNodeStylesCached,
  } = await import("../features/design-workspace/state/design-workspace-cache");
  const { captureDesignRuntimeScreenshot } =
    await import("../features/design-workspace/state/design-selection");
  const { useDesignWorkspaceUiStore } =
    await import("../features/design-workspace/state/design-workspace-ui");
  const { useDesignRuntimeStore } =
    await import("../features/design-workspace/state/design-runtime-store");
  const { setActiveBridge } = await import("../platform/bridge/active-bridge");
  const { setWorkspaceRowsForTesting } = await import("../state/use-projects");
  const { useWorkspaceStore } = await import("../state/store");

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
    assets: [],
    lint: {
      workspacePath,
      checkedFiles: ["home.html", "pricing.html"],
      violations: reviewFindings,
      healedOids: 0,
    },
  });
  for (const [file, sourceVersion, nodeCount] of [
    ["home.html", HOME_SOURCE_VERSION, 12],
    ["pricing.html", PRICING_SOURCE_VERSION, 18],
  ] as const) {
    designFoundationCache.setData(
      designFoundationKey(workspaceId, file, sourceVersion),
      {
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
          keyframes: [],
        },
      } as never,
    );
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
  useDesignWorkspaceUiStore
    .getState()
    .setSelection(workspaceId, "home.html", "home-heading");

  let currentWorkspaceSnapshot =
    designWorkspaceSnapshotCache.getSnapshot(workspaceId).data!;
  let currentHomeSource = homeSource;
  let styleGenerationCounter = 0;
  let textTransactionCounter = 0;
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
  setActiveBridge({
    status: "connected",
    on: () => () => {},
    onStatusChange: () => () => {},
    request: async (message: {
      type?: string;
      op?: string;
      params?: Record<string, unknown>;
    }) => {
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
        const previousFoundation = designFoundationCache.getSnapshot(
          designFoundationKey(workspaceId, "home.html", requestedSourceVersion),
        ).data;
        if (previousFoundation) {
          designFoundationCache.setData(
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
        await new Promise((resolve) => window.setTimeout(resolve, 50));
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
        const transaction = message.params?.transaction as
          | {
              transactionId?: string;
              documentId?: string;
              operations?: Array<{
                operationId?: string;
                type?: string;
                nodeId?: string;
                text?: string;
                styles?: Record<string, string>;
              }>;
            }
          | undefined;
        const textOperation = transaction?.operations?.find(
          (operation) => operation.type === "node.set-text",
        );
        if (textOperation) {
          const frameFile = String(message.params?.frame ?? "");
          const currentFrame = currentWorkspaceSnapshot.frames.find(
            (frame) => frame.file === frameFile,
          );
          if (!currentFrame || !textOperation.nodeId) {
            throw new Error("The text transaction target is unavailable.");
          }
          const beforeRevision = `harness:${currentFrame.sourceVersion}`;
          const parsed = new DOMParser().parseFromString(
            currentHomeSource,
            "text/html",
          );
          const target = parsed.querySelector<HTMLElement>(
            `[data-oid="${CSS.escape(textOperation.nodeId)}"]`,
          );
          if (!target) {
            throw new Error("The text transaction node is unavailable.");
          }
          target.textContent = String(textOperation.text ?? "");
          for (const operation of transaction?.operations ?? []) {
            if (operation.type !== "node.set-styles") continue;
            for (const [property, value] of Object.entries(
              operation.styles ?? {},
            )) {
              target.style.setProperty(property, value);
            }
          }
          currentHomeSource = `<!doctype html>${parsed.documentElement.outerHTML}`;
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
          designFrameDocumentCache.setData(
            designFrameDocumentKey(workspaceId, frameFile, nextSourceVersion),
            {
              ...nextFrame,
              source: currentHomeSource,
              srcDoc: withDesignRuntime(currentHomeSource, nextSourceVersion),
              tree: [],
            },
          );
          const previousFoundation = designFoundationCache.getSnapshot(
            designFoundationKey(
              workspaceId,
              frameFile,
              currentFrame.sourceVersion,
            ),
          ).data;
          if (previousFoundation) {
            designFoundationCache.setData(
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
          applyDesignWorkspaceRefreshVersion(
            workspaceId,
            10 + textTransactionCounter,
          );
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
        const previousFoundation = designFoundationCache.getSnapshot(
          designFoundationKey(workspaceId, "home.html", previousSourceVersion),
        ).data;
        if (previousFoundation) {
          designFoundationCache.setData(
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
        const previousFoundation = designFoundationCache.getSnapshot(
          designFoundationKey(workspaceId, frameFile, previousSourceVersion),
        ).data;
        if (previousFoundation) {
          designFoundationCache.setData(
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
        designFoundationCache.setData(
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
      if (message.op === "design.foundation.open") {
        const frameFile = String(message.params?.frame ?? "");
        const sourceVersion = currentWorkspaceSnapshot.frames.find(
          (frame) => frame.file === frameFile,
        )?.sourceVersion;
        const foundation = sourceVersion
          ? designFoundationCache.getSnapshot(
              designFoundationKey(workspaceId, frameFile, sourceVersion),
            ).data
          : null;
        if (!foundation) {
          throw new Error("The harness foundation is unavailable.");
        }
        return { type: "WORKSPACE_RESPONSE", result: foundation };
      }
      if (message.op === "design.snapshot") {
        return {
          type: "WORKSPACE_RESPONSE",
          result: { snapshot: currentWorkspaceSnapshot },
        };
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
      if (message.op === "design.stage") {
        designShortcutOperations.push("stage:start");
        await new Promise((resolve) => window.setTimeout(resolve, 50));
        designShortcutOperations.push("stage:end");
        return {
          type: "WORKSPACE_RESPONSE",
          result: { ok: true },
        };
      }
      if (message.op === "design.save") {
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
        return { type: "WORKSPACE_RESPONSE", result: { ok: true } };
      }
      return { type: "WORKSPACE_RESPONSE", result: { ok: true } };
    },
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
    return (
      <TooltipProvider delayDuration={300} skipDelayDuration={0}>
        <main className="bg-bg1 flex h-screen min-h-0 overflow-hidden">
          <DesignWorkspaceSidebar surfaceActive />
          <DesignWorkspaceColumn
            workspace={workspace}
            folder={workspacePath}
            surfaceActive
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
