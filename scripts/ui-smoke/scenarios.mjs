import { readFileSync } from "node:fs";

export const SHARD_COUNT = 3;
export const smokeShards = JSON.parse(
  readFileSync(new URL("./shards.json", import.meta.url), "utf8"),
);

function fresh(id, module, run, width = 1280, height = 720, page = id) {
  return {
    id,
    module: `../ui-smoke-${module}.mjs`,
    run,
    fixture: { page, viewport: { width, height }, navigation: "self" },
  };
}

function shared(id, module, run, width = 1440, height = 900) {
  return {
    ...fresh(id, module, run, width, height, "main"),
    fixture: {
      page: "main",
      viewport: { width, height },
      navigation: "origin",
    },
  };
}

// The four inline envelopes share console history and a page. Keep them one
// sharding unit, with phases so the default run still inserts Design and file
// prefetch between the model-menu and diff/files checks.
const coreInline = {
  ...shared("core-inline", "composer", "", 900, 700),
  module: "./core-inline.mjs",
  phases: {
    "model-menu": {
      run: "runModelMenuSmoke",
      viewport: { width: 900, height: 700 },
    },
    "diff-files": {
      run: "runDiffFilesSmoke",
      viewport: { width: 1440, height: 900 },
    },
    "github-settings": {
      run: "runGithubSettingsSmoke",
      viewport: { width: 1440, height: 900 },
    },
    "browser-retention": {
      run: "runBrowserRetentionSmoke",
      viewport: { width: 1440, height: 900 },
    },
  },
};

// Order and fixtures come from the original serial runner. The full run keeps
// its shared pages and inherited viewport changes. A shard gives each unit a
// separate context seeded at this viewport and, where needed, a valid origin.
export const scenarioRegistry = [
  fresh(
    "git-review-actions",
    "git-review-actions",
    "runGitReviewActionsSmoke",
    1100,
    780,
  ),
  fresh("code-review", "code-review", "runCodeReviewSmoke", 1180, 900),
  fresh(
    "code-review-retention",
    "review-retention",
    "runCodeReviewRetentionSmoke",
    1180,
    900,
    "code-review",
  ),
  fresh(
    "create-composer",
    "create-composer",
    "runCreateComposerSmoke",
    1100,
    780,
  ),
  fresh(
    "create-source-immediate-escape",
    "create-source-focus",
    "runCreateSourceImmediateEscapeSmoke",
    1100,
    780,
  ),
  fresh(
    "create-source-tooltip-escape",
    "create-source-focus",
    "runCreateSourceTooltipEscapeSmoke",
    1100,
    780,
  ),
  fresh(
    "cloud-workspace",
    "cloud-workspace",
    "runCloudWorkspaceSmoke",
    900,
    650,
  ),
  fresh("cloud-replica", "cloud-replicas", "runCloudReplicaSmoke", 1100, 850),
  fresh("cloud-preview", "cloud-previews", "runCloudPreviewSmoke", 900, 650),
  fresh("cloud-terminal", "cloud-terminal", "runCloudTerminalSmoke", 1100, 780),
  fresh("cloud-settings", "cloud-settings", "runCloudSettingsSmoke", 1000, 850),
  {
    ...fresh(
      "cloud-computer-v2",
      "cloud-computer-v2",
      "runCloudComputerV2Smoke",
      1100,
      900,
    ),
    // The base case and every regression profile form one unit; each needs a
    // fresh page/context, as in the original loop.
    regressions: "cloudComputerV2ReviewRegressions",
  },
  fresh("context-gauge", "context-gauge", "runContextGaugeSmoke"),
  fresh("permission-hints", "permission-hints", "runPermissionHintsSmoke"),
  fresh(
    "conversation-summary",
    "conversation-summary",
    "runConversationSummarySmoke",
  ),
  fresh(
    "overlay-positioning",
    "overlay-positioning",
    "runOverlayPositioningSmoke",
  ),
  fresh("draft-indicators", "draft-indicators", "runDraftIndicatorsSmoke"),
  fresh("app-sidebar", "app-sidebar", "runAppSidebarSmoke", 1280, 800),
  fresh("chat-titles", "chat-titles", "runChatTitlesSmoke"),
  shared(
    "composer-editor",
    "composer-editor",
    "runComposerEditorSmoke",
    900,
    700,
  ),
  shared("design-mode", "design-mode", "runDesignModeSmoke", 900, 700),
  shared(
    "attachment-persistence",
    "attachment-persistence",
    "runAttachmentPersistenceSmoke",
    900,
    700,
  ),
  shared(
    "attachment-layout",
    "attachment-layout",
    "runAttachmentLayoutSmoke",
    900,
    700,
  ),
  coreInline,
  shared(
    "design-floating-chrome",
    "design-floating-chrome",
    "runDesignFloatingChromeSmoke",
    900,
    700,
  ),
  shared(
    "design-floating-chrome-edges",
    "design-floating-chrome-edges",
    "runDesignFloatingChromeEdgesSmoke",
  ),
  shared("design-workbench", "design-workbench", "runDesignWorkbenchSmoke"),
  shared("design-selection", "design-selection", "runDesignSelectionSmoke"),
  shared(
    "design-auto-layout",
    "design-auto-layout",
    "runDesignAutoLayoutSmoke",
  ),
  shared(
    "design-spacing",
    "design-spacing",
    "runDesignSpacingSmoke",
    1280,
    900,
  ),
  shared(
    "design-layout-gestures",
    "design-layout-gestures",
    "runDesignLayoutGesturesSmoke",
  ),
  shared(
    "design-inspector-races",
    "design-inspector-races",
    "runDesignInspectorRacesSmoke",
    1440,
    960,
  ),
  shared(
    "design-inspector-edits",
    "design-inspector-edits",
    "runDesignInspectorEditsSmoke",
    1440,
    960,
  ),
  shared("design-layout", "design-layout", "runDesignLayoutSmoke", 1440, 960),
  shared(
    "design-layout-children",
    "design-layout-children",
    "runDesignLayoutChildrenSmoke",
    1440,
    960,
  ),
  shared(
    "design-frame-children",
    "design-frame-children",
    "runDesignFrameChildrenSmoke",
    1440,
    960,
  ),
  shared(
    "design-authored-frame",
    "design-authored-frame",
    "runDesignAuthoredFrameSmoke",
    1440,
    960,
  ),
  shared(
    "design-loading-edits",
    "design-loading-edits",
    "runDesignLoadingEditsSmoke",
    1440,
    960,
  ),
  shared(
    "design-frame-recovery",
    "design-frame-recovery",
    "runDesignFrameRecoverySmoke",
    1440,
    960,
  ),
  shared(
    "design-inline-tools",
    "design-inline-tools",
    "runDesignInlineToolsSmoke",
  ),
  shared("design-camera", "design-camera", "runDesignCameraSmoke"),
  shared("design-preview", "design-preview", "runDesignPreviewSmoke"),
  shared(
    "design-interaction-integrity",
    "design-interaction-integrity",
    "runDesignInteractionIntegritySmoke",
  ),
  shared(
    "design-panel-integrity",
    "design-panel-integrity",
    "runDesignPanelIntegritySmoke",
  ),
  shared(
    "design-canvas-refinements",
    "design-canvas-refinements",
    "runDesignCanvasRefinementsSmoke",
  ),
  shared(
    "design-motion-refinements",
    "design-motion-refinements",
    "runDesignMotionRefinementsSmoke",
  ),
  shared(
    "design-style-refinements",
    "design-style-refinements",
    "runDesignStyleRefinementsSmoke",
  ),
  shared("design-pages", "design-pages", "runDesignPagesSmoke"),
  shared(
    "design-workspace-canvas",
    "design-workspace",
    "runDesignWorkspaceCanvasSmoke",
  ),
  shared("file-prefetch", "file-prefetch", "runFilePrefetchSmoke"),
  shared("personal-organization", "personal", "runPersonalOrganizationSmoke"),
  shared("mentions", "mentions", "runMentionsSmoke"),
  shared(
    "composer-attachments",
    "composer-attachments",
    "runComposerAttachmentsSmoke",
  ),
  shared("customize", "customize", "runCustomizeSmoke"),
  shared("tools", "tools", "runToolsSmoke"),
  shared("native-tools", "native-tools", "runNativeToolsSmoke"),
  shared("codex-transcript", "codex-transcript", "runCodexTranscriptSmoke"),
  shared("repo-settings", "repo-settings", "runRepoSettingsSmoke"),
  shared("folder-workspace", "folder-workspace", "runFolderWorkspaceSmoke"),
  shared(
    "workspace-recovery-navigation",
    "folder-workspace",
    "runWorkspaceRecoveryNavigationSmoke",
  ),
  shared("folder-review", "folder-review", "runFolderReviewSmoke"),
  shared("folder-files", "folder-files", "runFolderFilesSmoke"),
  shared("start-from-scratch", "folder-create", "runStartFromScratchSmoke"),
  shared("folder-auto-setup", "folder-create", "runFolderAutoSetupSmoke"),
  shared(
    "create-project-selection",
    "folder-create",
    "runCreateProjectSelectionSmoke",
  ),
  shared("folder-create", "folder-create", "runFolderCreateSmoke"),
  shared("folder-design-setup", "folder-create", "runFolderDesignSetupSmoke"),
  shared("dialog-chrome", "project-folder-setup", "runDialogChromeSmoke"),
  shared(
    "terminal-workbench",
    "terminal-workbench",
    "runTerminalWorkbenchSmoke",
  ),
  shared(
    "workspace-archives",
    "workspace-archives",
    "runWorkspaceArchivesSmoke",
    1100,
    800,
  ),
  shared("pr-actions", "pr-actions", "runPrActionsSmoke", 1100, 800),
  shared(
    "activity-disclosure",
    "activity-disclosure",
    "runActivityDisclosureSmoke",
    1100,
    800,
  ),
  shared("sticky-bottom", "sticky-bottom", "runStickyBottomSmoke", 1100, 800),
  // Subscription installs a context-wide clock. Keep it last, including in its
  // shard; its context is also isolated from other units in a sharded run.
  shared("subscription", "subscription", "runSubscriptionSmoke", 1100, 800),
];

const defaultSteps = scenarioRegistry.flatMap(({ id }) => {
  if (id === coreInline.id) return [{ id, phase: "model-menu" }];
  if (id === "file-prefetch") {
    return [
      { id },
      ...Object.keys(coreInline.phases)
        .slice(1)
        .map((phase) => ({ id: coreInline.id, phase })),
    ];
  }
  return [{ id }];
});

export function validateSmokePartition(partition = smokeShards) {
  if (
    !Array.isArray(partition) ||
    partition.length !== SHARD_COUNT ||
    !partition.every(Array.isArray)
  ) {
    throw new Error(
      "ui-smoke partition must contain three arrays of scenario IDs",
    );
  }
  const registryIds = new Set(scenarioRegistry.map(({ id }) => id));
  const assigned = new Set();
  for (const id of partition.flat()) {
    if (!registryIds.has(id))
      throw new Error(`unknown ui-smoke scenario in partition: ${id}`);
    if (assigned.has(id))
      throw new Error(`ui-smoke scenario assigned more than once: ${id}`);
    assigned.add(id);
  }
  const missing = [...registryIds].filter((id) => !assigned.has(id));
  if (missing.length)
    throw new Error(`ui-smoke partition is missing: ${missing.join(", ")}`);
}

export function selectScenarios(shard) {
  if (shard === undefined) return scenarioRegistry;
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) {
    throw new Error(`ui-smoke shard must be between 1 and ${SHARD_COUNT}`);
  }
  const assigned = new Set(smokeShards[shard - 1]);
  return scenarioRegistry.filter(({ id }) => assigned.has(id));
}

export function selectScenarioSteps(shard) {
  const selected = new Set(selectScenarios(shard).map(({ id }) => id));
  return defaultSteps.filter(({ id }) => selected.has(id));
}
