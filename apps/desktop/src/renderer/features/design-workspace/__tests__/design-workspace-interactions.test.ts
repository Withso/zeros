import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace.tsx",
  ),
  "utf8",
);
const themeSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-theme-editor.tsx",
  ),
  "utf8",
);
const uiSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace-ui.css",
  ),
  "utf8",
);
const semanticTokensSource = readFileSync(
  resolve(process.cwd(), "styles/semantic-tokens.css"),
  "utf8",
);
const layersSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-workspace-sidebar-panels.tsx",
  ),
  "utf8",
);
const disclosureSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/state/design-layer-disclosure.ts",
  ),
  "utf8",
);
const selectionSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/state/design-selection.ts",
  ),
  "utf8",
);
const styleEditorSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-style-editor.tsx",
  ),
  "utf8",
);
const motionTimelineSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-motion-timeline.tsx",
  ),
  "utf8",
);
const runtimeIframeSource = readFileSync(
  resolve(
    process.cwd(),
    "apps/desktop/src/renderer/features/design-workspace/design-frame-runtime-iframe.tsx",
  ),
  "utf8",
);
const appShellSource = readFileSync(
  resolve(process.cwd(), "apps/desktop/src/renderer/app-shell.tsx"),
  "utf8",
);
const DESIGN_BLUE = `#${"0C8CE9"}`;
const DESIGN_GAP_PINK = `#${"F531B3"}`;
const DESIGN_WHITE = `#${"FFFFFF"}`;

describe("design workspace interaction wiring", () => {
  it("keeps the selected frame and engine selection aligned on canvas clicks", () => {
    // An empty-canvas click keeps the frame active for the Layers panel but
    // deselects — activation, not frame selection.
    expect(source).toContain(
      "if (event.target === event.currentTarget) publishSelection(selectedFrame);",
    );
    expect(source).not.toContain(
      "if (event.target === event.currentTarget) publishSelection(null);",
    );
  });

  it("selects top-level frames only from their label, never their body", () => {
    // The label (and frame handles) are the frame's selection surfaces…
    expect(source).toContain("publishSelection(frame, { selected: true });");
    // …frame chrome follows the explicit frame-selected flag…
    expect(source).toContain(
      "selected && view.frameSelected && !selectedElement;",
    );
    // …and body clicks resolve through the local tree so a body-like root
    // reads as empty canvas instead of selecting the frame.
    expect(source).toContain("const resolveFrameBodyHit = useCallback(");
    expect(source).toContain("resolveDesignFrameBodyTarget({");
    expect(source).toContain("if (!pointer.shiftKey) publishSelection(frame);");
    // Escape steps node → frame → nothing.
    expect(source).toContain(
      'if (event.key === "Escape" && view.frameSelected && selectedFrame)',
    );
  });

  it("draws resting constraint guides and Option-measured target distances", () => {
    // Dashed runs reach only the parent edges the element's own CSS pins it to
    // — Figma's constraint, in the properties HTML actually has.
    expect(source).toContain("function DesignConstraintGuides({");
    expect(source).toContain("designConstraintSides({");
    expect(source).toContain("data-design-parent-guide={guide.side}");
    expect(source).toContain("data-design-parent-guides={nodeId}");
    // They live in frame space beside the rotated overlay, not inside it, so a
    // turned element keeps screen-aligned constraint lines.
    expect(source).toContain("designSelectionBoxBounds(");
    expect(source).toContain("function paintDesignConstraintGuides(");
    expect(source).not.toContain("function DesignParentGuides({");
    expect(source).toContain("const DesignMeasureOverlay = React.memo(");
    expect(source).toContain("designMeasureSpacing(selected.rect, target)");
    expect(source).toContain('data-design-measure-target=""');
    expect(source).toContain("parentGuideRect &&");
    expect(uiSource).toContain(".zd-design-parent-guide");
  });

  it("keeps style previews transient, scalar-keyed, and stable across source commits", () => {
    expect(source).toContain("onCancelPreview");
    expect(source).toContain("clearDesignNodeStylePreviewTransient(input)");
    expect(source).toContain("useDesignLivePreviewValue(");
    expect(source).toContain("finishCommittedPreview");
    expect(source).toContain("paintDesignInspectorPreviewDetails(");
    expect(source).toContain("designStylePropertyAffectsLayout");
    expect(source).toContain(
      'key={`${styleContext.workspaceId}:${styleContext.frame.file}:${styleNodeIds.join(":")}:${property}`}',
    );
    expect(source).not.toContain(
      "previewDesignNodeStyles({ ...input, folder })",
    );
  });

  /** A held pointer gesture is modal: for as long as one runs it owns the
   * keyboard. Escape used to fall through to the canvas selection stack, so a
   * drag jumped the selection to the parent — unmounting the overlay it was
   * painting — and then committed anyway on release. Delete, Cmd+D and the
   * arrow-key resize reached the same held element. */
  it("gives a running gesture the keyboard, and Escape to abort with", () => {
    const guard = source.indexOf("if (gestureCancelRef.current) {");
    expect(guard).toBeGreaterThan(-1);
    // Before the focus gate: a drag is as often started from a Layers
    // selection, which leaves focus outside the canvas viewport entirely.
    expect(guard).toBeLessThan(
      source.indexOf("if (!viewport.contains(document.activeElement)) return;"),
    );
    expect(guard).toBeLessThan(
      source.indexOf(
        "const editableTarget = isEditableHotkeyTarget(event.target);",
      ),
    );
    // One owner, not one listener per gesture: the three that had wired their
    // own window keydown are covered by the same guard.
    expect(source).not.toContain('if (keyboardEvent.key !== "Escape") return;');
  });

  it("routes copy, duplicate, and delete through the active semantic selection", () => {
    expect(source).toContain("resolveDesignSelectionShortcut(");
    expect(source).toContain(
      'activeElement.closest("[data-design-workspace-surface]")',
    );
    expect(source).toContain("void duplicateSelectedFrame(duplicateMode)");
    expect(source).toContain("void duplicateSelectedNode(duplicateMode)");
    expect(source).toContain(
      "if (selectedNodeIsTarget) void deleteSelectedNode()",
    );
    // Layers leaves structural shortcuts to the canvas's one selection owner,
    // so multi-selection and frame selection behave identically everywhere.
    expect(layersSource).not.toContain('mutateLayer("duplicate"');
    expect(layersSource).not.toContain('mutateLayer("delete"');
  });

  it("presents frame, text, image, and vector names without leaking HTML labels", () => {
    expect(layersSource).toContain("designFrameLayerLabel(frame.kind)");
    expect(layersSource).toContain("designRuntimeLayerLabel(layer.node)");
    expect(layersSource).not.toContain("frame.title}");
    expect(layersSource).not.toContain("layer.node.name.trim()");
    expect(layersSource).not.toContain("${layer.node.tag}");
  });

  /** A trackpad pinch repaints the camera up to 80ms before the store learns
   * the new zoom. Every gesture that divides pointer travel by a zoom has to
   * divide by the painted one, or it tracks the pointer at the wrong rate for
   * the rest of the drag. */
  it("measures every gesture's pointer travel against the painted zoom", () => {
    // No gesture may divide pointer travel, a snap tolerance, or a movement
    // threshold by the store's zoom.
    expect(source).not.toMatch(/\/ view\.zoom;/);
    expect(source).not.toMatch(/< 3 \/ view\.zoom\)/);
    expect(source).not.toMatch(/, 6 \/ view\.zoom\)/);
    expect(source).toContain(
      "const delta = (coordinate - startCoordinate) / liveDesignZoom();",
    );
  });

  /** A second drag can begin before the first one's commit has been adopted,
   * and the store still holds the pre-commit details until it is. Every gesture
   * that authors a length rebases on the speculative value instead — but only
   * where that value is a length it can add to, since an inspector can leave
   * `50%` or `calc(…)` there and only the computed value resolves it. */
  it("rebases every gesture on the value the commit is still landing", () => {
    expect(source).toContain("function designGesturePixelBase(");
    // Only a length the gesture can add to; otherwise the computed value.
    expect(source).toContain("designPixelLength(computed) ??");
    // The direct reads the three gestures used before, in offsets and in sizes.
    expect(source).not.toContain("pixelOffset(details.styles.left)");
    expect(source).not.toContain("pixelOffset(details.styles.top)");
    expect(source).not.toContain("start.details.styles.width");
    expect(source).not.toContain("start.details.styles.height");
  });

  /** Typing in an inspector field is a draft. A canvas write per keystroke
   * reflowed the document through every intermediate string — including the
   * empty one a backspace leaves behind, which removes the declaration
   * outright. Direct manipulation (the label scrub, sliders, colour drags)
   * stays live; those call preview() from their own handlers. */
  it("keeps a typed inspector value out of the canvas until it is committed", () => {
    expect(source).not.toContain(
      "preview(resolveDraft(next, baselineRef.current))",
    );
    expect(source).toContain("const text = event.target.value;");
    expect(source).toContain("setPresentedDraft(text);");
    expect(source).toContain(
      "if (!previewDirtyRef.current) preview(resolvedDraft);",
    );
    // The scrub drag is direct manipulation and must stay live.
    expect(source).toContain("scrub.latestValue = next;");
    expect(source).toContain("preview(next);");
  });

  /** Every gesture shares one dispatcher: one flight, newest styles win, and
   * the measurement it answers with describes the element as it stands. That is
   * what stops an overlay from leading the element it describes. */
  it("routes every canvas gesture through one coalesced preview loop", () => {
    expect(source).toContain(
      "createDesignGestureLoop<DesignRuntimeNodeGeometry>",
    );
    expect(source).toContain("previewDesignNodeGeometry({");
    expect(source).toContain("loop.author(");
    expect(source).toContain("loop.stop();");
    // No gesture may keep its own rAF/in-flight bookkeeping any more.
    expect(source).not.toContain("previewInFlight");
    expect(source).not.toContain("previewQueued");
    expect(source).not.toContain("const schedulePreview");
  });

  /** A gesture authors whole pixels. Painting the pointer's fractional
   * rectangle instead left the overlay half a pixel from the element, and
   * rounding an offset and a size independently made the edge the user was
   * holding oscillate a full pixel twice per pixel of travel. */
  it("paints a gesture from the integers it authors", () => {
    expect(source).toContain("designAuthoredResizeAxis({");
    expect(source).toContain("authorsSize: axes.width");
    expect(source).toContain(
      "start.width + horizontal.sizeTravel * box.scaleX",
    );
    expect(source).not.toContain("latestStyles = stylesForRect(snapped.rect)");
  });

  /** Reading the overlay's rect on every pointer event forced a host layout
   * mid-drag; the containment test it fed is a CSS question. */
  it("answers the spacing hover state without a layout read", () => {
    expect(source).toContain('data-design-spacing-hover-zone=""');
    expect(source).not.toContain('"data-design-spacing-hover",');
    expect(uiSource).toContain("[data-design-spacing-hover-zone]:hover");
  });

  /** An imperative label paint must keep the text node React rendered: both
   * `replaceChildren` and `textContent` detach it, after which React's own
   * updates write into a node that is no longer in the document. */
  it("paints canvas labels through the node React owns", () => {
    expect(source).toContain("function paintDesignLabelText(");
    expect(source).toContain("first.nodeValue = text;");
    expect(source).not.toContain("?.replaceChildren(");
  });

  it("keeps the empty motion-definition identity stable while foundation data is cold", () => {
    expect(source).toContain("EMPTY_DESIGN_KEYFRAME_DEFINITIONS");
    expect(source).not.toContain("foundation.keyframes ?? []");
  });

  it("does not reset a motion draft when its own preview refreshes node details", () => {
    expect(motionTimelineSource).toContain("detailsOwner");
    expect(motionTimelineSource).toContain(
      'const detailsOwner = details?.oid ?? ""',
    );
    expect(motionTimelineSource).not.toContain("[definitions, details]");
    expect(source).not.toContain(
      'key={`${selectedFrame?.sourceVersion ?? "none"}',
    );
    expect(source).toContain(
      'key={`${workspaceId ?? "none"}:${selectedFrame?.file ?? "none"}:${selectedNodeDetails?.oid ?? "frame"}`}',
    );
  });

  it("keeps style generations mounted and live-buffers structural navigation", () => {
    expect(runtimeIframeSource).toContain("documentSourceVersion");
    expect(runtimeIframeSource).toContain(
      'type DesignDocumentBuffer = "displayed" | "incoming"',
    );
    expect(runtimeIframeSource).toContain(
      "designFrameRuntime(current.workspaceId, current.frame.file)",
    );
    expect(runtimeIframeSource).toContain(
      "data-design-document-buffer={buffer}",
    );
    expect(runtimeIframeSource).toContain(
      "setDisplayedSourceVersion(sourceVersion)",
    );
    expect(runtimeIframeSource).toContain("setIncomingSourceVersion(null)");
    expect(runtimeIframeSource).toContain(
      'entry.buffer === "incoming" || incomingSourceVersion === null',
    );
    expect(runtimeIframeSource).not.toContain("pinnedTransitionCover");
    expect(runtimeIframeSource).not.toContain("outgoingSourceVersion");
  });

  it("localizes animation-frame and Layers-hover updates outside the canvas parent", () => {
    expect(source).toContain("publishDesignMotionPlayhead(");
    expect(source).toContain("useDesignMotionPlayhead(owner)");
    expect(source).toContain("DesignLayerHoverOverlay");
    expect(source).not.toContain("const hoveredFrame = useDesignRuntimeStore(");
  });

  it("retains a bounded inert MRU deck for design-workspace switches", () => {
    expect(appShellSource).toContain("designWorkspaceIdsToRender");
    expect(appShellSource).toContain("data-design-retained-workspace");
    expect(appShellSource).toContain("surfaceActive={entryActive && !isHome}");
    // The active deck must not re-enable painting under the Home shell's
    // hidden wrapper — `visible` on a child beats `invisible` on an ancestor
    // and lets z-indexed layer rows bleed through the Home sidebar.
    expect(appShellSource).toContain(
      "const entryVisible = entryActive && !isHome;",
    );
    expect(appShellSource).toContain(
      '{...(!entryVisible ? { inert: "" } : {})}',
    );
  });

  it("keeps the persisted code-column collapse out of design workspaces", () => {
    const sidebarWiring = appShellSource.match(
      /<DesignWorkspaceSidebar[\s\S]*?\/>/,
    )?.[0];
    const columnWiring = appShellSource.match(
      /<DesignWorkspaceColumn[\s\S]*?\/>/,
    )?.[0];

    expect(sidebarWiring).toBeDefined();
    expect(columnWiring).toBeDefined();
    expect(sidebarWiring).not.toContain("workbenchCollapsed");
    expect(columnWiring).not.toContain("workbenchCollapsed");
    expect(source).not.toContain("WorkbenchToggleButton");
    expect(source).not.toContain("onToggleWorkbench");
  });

  it("keeps inverse-scaled motion-path strokes stable at low canvas zoom", () => {
    expect(source).toContain("strokeWidth: designCanvasScreenPixels(2)");
    expect(source).not.toContain('vectorEffect="non-scaling-stroke"');
  });

  it("paints camera transforms and screen-space chrome from one synchronous zoom", () => {
    expect(source).toContain("function paintDesignCanvasCamera(");
    expect(source).toContain('"--design-canvas-zoom"');
    expect(source).toContain('"--design-canvas-inverse-zoom"');
    expect(source).toContain(
      'world.toggleAttribute("data-design-camera-gesture", gestureActive)',
    );
    expect(source).not.toContain(
      "worldRef.current.style.transform = `translate(",
    );
  });

  it("suppresses layout tooling during camera gestures and uses a projected-width frame name", () => {
    expect(uiSource).toContain(
      "[data-design-camera-gesture] [data-design-inline-spacing-root]",
    );
    expect(source).toContain('data-design-frame-name=""');
    expect(source).toContain('"--design-frame-label-max-width"');
    expect(source).not.toContain('data-design-frame-size=""');
  });

  it("keeps stale world-anchored tiles painted until the decoded replacement lands", () => {
    expect(source).toContain("designHighResolutionTileKey(");
    expect(source).toContain("await decodeDesignHighResolutionCapture(");
    expect(source).toContain(
      "mountedHighResolutionCapture?.tileKey === requestedTileKey",
    );
    // Hiding a stale tile flashes the compositor-magnified iframe on every
    // settled zoom step; the previous capture must stay painted instead.
    expect(source).not.toContain("visibleHighResolutionCapture");
    expect(source).not.toContain('? "visible" : "hidden"');
    expect(source).not.toContain("window.setTimeout(capture, 60)");
  });

  it("serializes viewport rasterizations with a latest-wins capture queue", () => {
    expect(source).toContain("captureFlightRef");
    expect(source).toContain("flight.queued = capture");
    expect(source).toContain(
      "if (flight.queued === capture) flight.queued = null;",
    );
  });

  it("keeps inline text paintable by suppressing runtime glyphs only after the editor mounts", () => {
    // Editing must carry its start-of-edit details so the editor mounts in
    // the same commit, and glyph suppression must be requested by the mounted
    // editor — never speculatively before it exists. A slow or failed
    // selection readback then degrades to a brief identical double-paint
    // instead of invisible text.
    expect(source).toContain("initialDetails: details,");
    expect(source).toContain(
      'details ?? (edit.kind === "existing" ? edit.initialDetails : null)',
    );
    expect(source).toContain("const suppressInlineTextGlyphs = useCallback(");
    expect(source).toContain("onMounted={suppressInlineTextGlyphs}");
    expect(source).toContain("onMounted(edit);");
  });

  it("keeps new-text drafts purely typographic without parent box constraints", () => {
    expect(source).toContain("padding: isExisting ? computed.padding : 0");
    expect(source).toContain(
      "borderTopWidth: isExisting ? computed.borderTopWidth : 0",
    );
    expect(source).toContain("const authoredMinHeight = isExisting");
  });

  it("zooms pinch and command-scroll through one shared factor helper", () => {
    expect(source).toContain("designWheelZoomFactor({");
    expect(source).toContain("ctrlKey: event.ctrlKey");
    expect(source).toContain("metaKey: event.metaKey");
    expect(source).not.toContain("-delta * 0.002");
  });

  it("keeps heavy Motion and Theme surfaces outside camera-only reconciliation", () => {
    expect(motionTimelineSource).toContain(
      "export const DesignMotionTimeline = React.memo(",
    );
    expect(themeSource).toContain(
      "export const DesignThemeEditor = React.memo(",
    );
    expect(source).toContain("const changeActiveTheme = useCallback(");
  });

  it("keeps visible selection affordances minimal while every outer edge resizes", () => {
    expect(source).toContain("data-design-resize-edge");
    expect(source).toContain("DESIGN_EDGE_RESIZE_HANDLES");
    // Visible squares are corner-only for every selection; edges keep their
    // invisible resize strips.
    expect(source).toContain("const handles = DESIGN_CORNER_RESIZE_HANDLES;");
    expect(source).not.toContain("cornersOnly");
  });

  it("carries no identity-and-actions pill above a selected element", () => {
    // Identity lives in Layers and the inspector; duplicate, delete, and text
    // editing keep their shortcuts and their double-click.
    expect(source).not.toContain("` · ${details.tag}`");
    expect(source).not.toContain("aria-label={`Duplicate ${details.name}`}");
    expect(source).not.toContain("aria-label={`Delete ${details.name}`}");
    expect(source).not.toContain("aria-label={`Edit text in ${details.name}`}");
    expect(source).toContain('selectionShortcut === "copy"');
    expect(source).toContain('selectionShortcut === "delete"');
    expect(source).toContain("void deleteSelectedNode();");
    expect(source).toContain("finishInlineTextTool(frame, details)");
  });

  it("rotates from outside every corner instead of one floating button", () => {
    // No separate rotate button, and no icon import left behind for one.
    expect(source).not.toContain("DesignRotateHandle");
    expect(source).not.toContain("RotateCw");
    expect(source).toContain("data-design-rotate-corner={corner}");
    expect(source).toContain("DESIGN_ROTATION_CORNERS.map(");
    // The zone starts outside the box so the corner resize square keeps its
    // own hit area, and its cursor is aimed by the selection's own rotation.
    expect(source).toContain("`calc(100% - ${inset})`");
    expect(source).toContain("designRotationCursor(rotation + cursorAngle)");
    // Rotation and its pivot belong to the Select tool only.
    expect(source).toContain(
      'const rotationToolsActive = activeTool === "select";',
    );
    expect(source).toContain("{rotationToolsActive ? (");
  });

  it("turns the selection box with the element it outlines", () => {
    // The overlay is anchored on the pivot, so a rotation gesture repaints
    // nothing but its transform.
    expect(source).toContain("designSelectionOverlayStyle(overlayFrame)");
    expect(source).toContain(
      "overlay.style.transform = `rotate(${latestRotation}deg)`",
    );
    expect(source).toContain(
      "overlay.style.transformOrigin = `${overlayFrame.pivotX}px ${overlayFrame.pivotY}px`",
    );
    // Hover outlines and the inline text editor turn with their element too.
    expect(source).toContain(
      "designSelectionOverlayFrame(designSelectionBox(details)),",
    );
    expect(source).toContain("transform: `rotate(${turned.rotation}deg)`,");
  });

  it("authors a movable rotation origin as real CSS", () => {
    expect(source).toContain("data-design-origin-handle");
    expect(source).toContain('"transform-origin": `${roundedOriginPercentage(');
    // Moving the pivot of a transformed element must not move the element.
    expect(source).toContain("designOriginTranslationShift({");
    // The reticle keeps a constant screen size and retires on a selection it
    // would cover, which is what zooming out far enough produces.
    expect(source).toContain("const DESIGN_ORIGIN_HANDLE_MINIMUM = 108;");
    expect(source).toContain("DESIGN_ORIGIN_HANDLE_MINIMUM / view.zoom");
    expect(source).toContain('viewBox="0 0 16 16"');
    expect(source).toContain("strokeWidth={1.4}");
    expect(uiSource).toContain(".zd-design-origin-marker");
    // Snap anchors appear only while the pivot is being dragged.
    expect(source).toContain('anchors.style.display = "block"');
  });

  it("holds the released rotation until its commit republishes", () => {
    // Repainting the pre-gesture angle on release snapped the outline upright
    // for a frame while the transient preview kept the element turned.
    expect(source).toContain("settle(latestRotation);");
    expect(source).toContain(
      "const settle = (rotation: number) => {\n        paintDesignNodeOverlayGeometry(overlay, { ...overlayFrame, rotation });",
    );
    expect(source).toContain(
      "const restore = () => {\n        settle(overlayFrame.rotation);",
    );
  });

  it("keeps rotated direct manipulation on the element's own axes", () => {
    // Resize travel rotates into the element's axes, and the authored offset
    // cancels the drift CSS growth-plus-pivot introduces.
    expect(source).toContain(
      "designLocalDelta({ x: screenX, y: screenY }, box.rotation)",
    );
    expect(source).toContain("designResizeLayoutOffset({");
    expect(source).toContain("designRotatedResizeOrigin({");
    // A rotated selection cannot snap to peer edges it does not share.
    expect(source).toContain("const snappingDisabled =\n          turned ||");
  });

  it("paints exact gap strips independently from their larger pointer targets", () => {
    expect(source).toContain("designInlineGapGeometry(");
    expect(source).toContain('data-design-inline-gap-visual=""');
    expect(source).not.toContain(
      'className="zd-design-inline-spacing-highlight pointer-events-none absolute inset-0"',
    );
  });

  it("keeps empty nodes motion-free and gates every preview to Motion mode", () => {
    expect(motionTimelineSource).toContain("keyframes: []");
    expect(motionTimelineSource).toContain("onDeleteMotion");
    expect(motionTimelineSource).toContain(
      "motionOwnerHash(`${ownerKey}\\u0000${details.oid}`)",
    );
    expect(motionTimelineSource).not.toContain(
      "points.filter(\n                  (point) => point.property === selectedPoint.property,\n                ).length <= 2",
    );
    expect(source).toContain("!motionTimelineOpen ||");
    expect(source).toContain("deleteMotion");
    expect(source).toContain('"animation-name": "none"');
    expect(source).toContain('"animation-duration": null');
  });

  it("warms frame source on code-view intent without a loading waterfall", () => {
    expect(source).toContain("onPointerEnter={warmSelectedFrameDocument}");
    expect(source).toContain("onFocus={warmSelectedFrameDocument}");
    expect(source).not.toContain("Loading frame source…");
    expect(source).toContain(
      "active && Boolean(workspaceId && selectedFrame),",
    );
    expect(source).not.toContain(
      "active && Boolean(workspaceId && selectedFrame && view.codeView),",
    );
  });

  it("keeps the theme editor non-modal, draggable, and isolated from canvas wheel input", () => {
    expect(themeSource).toContain("modal={false}");
    expect(themeSource).toContain('data-design-theme-drag-handle=""');
    expect(themeSource).toContain("onWheelCapture={(event) =>");
    expect(themeSource).not.toContain("<DialogContent");
  });

  it("keeps theme modes and variable types directly filterable", () => {
    expect(themeSource).toContain("data-design-theme-type-filter");
    expect(themeSource).toContain("zd-design-theme-mode-active");
    expect(uiSource).toContain(".zd-design-theme-mode-active");
  });

  it("prevents native document selection in editor chrome while preserving editable controls", () => {
    expect(uiSource).toContain("user-select: none");
    expect(uiSource).toContain("user-select: text");
    expect(source).toContain('event.key.toLowerCase() === "a"');
  });

  it("uses dedicated design-workspace colors for selection, padding, and gaps", () => {
    expect(semanticTokensSource).toContain(
      `--design-selection-stroke: ${DESIGN_BLUE}`,
    );
    expect(semanticTokensSource).toContain(
      `--design-padding-stroke: ${DESIGN_BLUE}`,
    );
    expect(semanticTokensSource).toContain(
      `--design-gap-stroke: ${DESIGN_GAP_PINK}`,
    );
    expect(semanticTokensSource).toContain(
      `--design-spacing-line-border: ${DESIGN_WHITE}`,
    );
    expect(semanticTokensSource).toContain("--design-selection-handle-fill:");
    expect(uiSource).toContain(".zd-design-selection-outline");
    expect(uiSource).toContain(".zd-design-selection-handle");
    expect(uiSource).toContain("var(--design-padding-stroke)");
    expect(uiSource).toContain("var(--design-gap-stroke)");
    expect(source).toContain("zd-design-selection-outline");
    expect(source).toContain("zd-design-selection-handle");
  });

  it("coordinates semantic selected and hovered states across Layers and canvas", () => {
    expect(layersSource).toContain("zd-design-layer-selected");
    expect(layersSource).toContain("zd-design-layer-hovered");
    // Selecting a container tints every row it owns, Figma-style, and hidden
    // subtrees fade without indent guide lines cluttering the tree.
    expect(layersSource).toContain("zd-design-layer-in-selection");
    expect(layersSource).toContain("zd-design-layer-dimmed");
    expect(layersSource).not.toContain("data-design-layer-guide");
    expect(uiSource).toContain(".zd-design-layer-selected");
    expect(uiSource).toContain(".zd-design-layer-hovered");
    expect(uiSource).toContain(".zd-design-layer-in-selection");
    // Hover and selection are matched per frame, because several frames can be
    // open at once and two documents may author the same node id.
    expect(layersSource).toContain("hoveredFrameFile === frame.file &&");
    expect(layersSource).toContain(
      "const activeFrame = selectedFrame?.file === frame.file;",
    );
  });

  it("keeps the Layers tree quiet, indented, and neutral", () => {
    // A tree this dense reads better without search chrome or a layer tally.
    expect(layersSource).not.toContain("Search layers");
    expect(layersSource).not.toContain("InputGroup");
    expect(layersSource).not.toContain("totalLayerCount");
    // The panel has one 12px type scale for headings, layer names, status
    // messages, and selection metadata.
    expect(layersSource).toContain(
      'className="bg-bg1 text-3xxs flex min-h-0 flex-1 flex-col overflow-hidden"',
    );
    expect(layersSource).not.toMatch(
      /\btext-(?:xxs|2xxs|xs|sm|base|lg|xl)\b|\btext-\[\d+px\]/,
    );
    // Rows indent from the frame row that owns them, and a row with nothing to
    // disclose reserves the chevron's footprint instead of drawing one.
    expect(layersSource).toContain("Math.min(depth + 1, 16)");
    expect(layersSource).toContain("DESIGN_LAYER_DISCLOSURE_SPACER");
    expect(layersSource).toContain("discloses: tree ? tree.length > 0 :");
    const layerRulesStart = uiSource.indexOf(".zd-design-layer-row {");
    const layerRulesEnd = uiSource.indexOf(".zd-design-theme-filter {");
    expect(layerRulesStart).toBeGreaterThan(-1);
    expect(layerRulesEnd).toBeGreaterThan(layerRulesStart);
    const layerRules = uiSource.slice(layerRulesStart, layerRulesEnd);
    // Layer selection is chrome: neutral surfaces only, so the design accent
    // stays unique to the canvas.
    expect(layerRules).toContain("var(--bg2-hover)");
    expect(layerRules).not.toContain("--design-selection");
    // Selection moves in one commit. A colour transition left the outgoing
    // frame's block fading in place while the incoming one faded in above it.
    expect(layerRules).toContain("transition: none");
    // Hiding a layer fades its label, never the fill it sits inside.
    expect(layerRules).not.toContain("opacity: 0.45");
  });

  it("keeps every frame's disclosure independent of the selection", () => {
    // Expansion is frame-owned state, not panel-local and not tied to which
    // frame is selected: any number of frames can stand open, each staying
    // exactly as the user left it.
    expect(layersSource).toContain("useDesignWorkspaceDisclosure");
    expect(layersSource).toContain("toggleDesignLayerExpanded");
    expect(layersSource).toContain("toggleDesignFrameTreeExpanded");
    expect(layersSource).not.toContain("CollapsedLayerState");
    expect(layersSource).not.toContain("collapsedNodeIds");
    // Only the chevron folds a frame; choosing one merely selects it.
    expect(layersSource).toContain("const toggleFrameTree = (");
    expect(layersSource).not.toContain("chooseFrame(frame);\n      return;");
    expect(disclosureSource).toContain("MAX_EXPANDED_NODE_IDS");
    expect(disclosureSource).toContain("MAX_FRAMES_PER_WORKSPACE");
    // A canvas click publishes the path that makes its row reachable.
    expect(selectionSource).toContain("revealDesignSelectionPath");
    // Collapse all closes the whole workspace, and stays available whenever
    // anything is open anywhere.
    expect(layersSource).toContain("collapseAllDesignLayers(workspaceId)");
    expect(layersSource).toContain("disabled={!hasExpandedLayers}");
    expect(disclosureSource).toContain("collapseWorkspace(workspaceId)");
  });

  it("renders every open frame in one virtualized tree", () => {
    // One row list interleaves frame rows, their layers, and pending frames, so
    // virtualization, keyboard travel, and the roving tab stop keep working
    // across frame boundaries.
    expect(layersSource).toContain("type DesignPanelRow =");
    expect(layersSource).toContain('kind: "pending"');
    expect(layersSource).toContain("data-design-panel-row={row.key}");
    expect(layersSource).toContain(
      "panelRows.length * DESIGN_LAYER_ROW_HEIGHT",
    );
    expect(layersSource).toContain('aria-label="Design layers"');
    // Rows fill the panel and round only at the run's outer edges, so the fill
    // reads as one container the selection owns.
    expect(layersSource).toContain("designLayerBlockEdges(");
    expect(layersSource).toContain('return "rounded-t-md rounded-b-none"');
    expect(layersSource).toContain('return "rounded-t-none rounded-b-md"');
    expect(layersSource).not.toContain("gap-px");
    // Structural shortcuts are declared by every row but execute through the
    // canvas's one semantic selection owner.
    expect(layersSource).toContain(
      'aria-keyshortcuts="Meta+C Control+C Meta+D Control+D Delete Backspace"',
    );
    expect(layersSource).not.toContain("readFrameFoundation");
    expect(layersSource).toContain(
      "const parentRowIndex = (index: number): number =>",
    );
    // An open frame is a live-runtime demand: its tree is the only thing that
    // can fill those rows, so it must not wait behind the viewport ranking.
    expect(source).toContain("requiredFiles: layersOpenFiles");
  });

  it("reads the Option measure modifier outside the canvas focus scope", () => {
    // The overlay is a display affordance, so it follows the live modifier
    // instead of a keydown that the sidebar's focus owner would have kept.
    expect(source).toContain("syncMeasureModifier(event.altKey)");
    expect(source).toContain(
      "onPointerMove={(event) => syncMeasureModifier(event.altKey)}",
    );
    expect(source).toContain('document.addEventListener("visibilitychange"');
    expect(source).not.toContain('if (event.key === "Alt") {');
  });

  it("exposes structured grid flow, alignment, and implicit-track controls", () => {
    expect(styleEditorSource).toContain('"grid-auto-flow"');
    expect(styleEditorSource).toContain('"grid-auto-columns"');
    expect(styleEditorSource).toContain('"grid-auto-rows"');
    expect(styleEditorSource).toContain('"justify-items"');
  });

  it("groups common style controls while retaining independent and advanced CSS properties", () => {
    expect(styleEditorSource).toContain('title="Layout"');
    expect(styleEditorSource).toContain('title="Appearance"');
    expect(styleEditorSource).toContain('title="Typography"');
    expect(styleEditorSource).toContain('"border-top-left-radius"');
    expect(styleEditorSource).toContain('"overflow-wrap"');
    expect(styleEditorSource).toContain('"perspective-origin"');
    expect(styleEditorSource).toContain("showAdvancedAppearance");
    expect(styleEditorSource).toContain("showAdvancedTypography");
  });

  it("exposes style keyframe actions only while Motion mode is active", () => {
    // Ordinary inspector fields and compound controls (fill, shadow, and
    // transform) have separate action renderers. Neither may leave an
    // Animate/keyframe button in the hover or keyboard path outside Motion.
    expect(source).toMatch(/motion=\{\s*motionModeActive\s*\?\s*\{/);
    expect(styleEditorSource).toMatch(
      /function MotionPropertyAction[\s\S]*?if \(!timelineOpen\) return null;/,
    );
  });

  it("keeps the style inspector hierarchy compact without overriding every child", () => {
    expect(uiSource.match(/font-size:\s*13px/g)).toHaveLength(1);
    expect(uiSource).toContain(".zd-design-field-actions");
    expect(source).toContain("aria-label={`Unit for ${label}`}");
    expect(styleEditorSource).toContain('label="Box sizing"');
  });

  it("keeps one Style inspector with PNG export and no Data or PR surface", () => {
    const inspector = source.match(
      /<aside[\s\S]*?data-design-inspector=""[\s\S]*?<\/aside>/,
    )?.[0];

    expect(inspector).toBeDefined();
    expect(source).toContain('aria-label="Export PNG"');
    expect(inspector).not.toContain('aria-label="Inspector modes"');
    expect(inspector).not.toContain('value="foundation"');
    expect(inspector).not.toContain("Tweaks");
    expect(inspector).not.toContain("Components");
    expect(inspector).not.toContain("CreatePrButton");
    expect(inspector).not.toMatch(/Open PR #|Create PR/);
  });

  it("programmatically names style selects and segmented control groups", () => {
    expect(styleEditorSource).toContain("aria-label={label}");
    expect(styleEditorSource).toContain('role="group"');
    expect(styleEditorSource).toContain(
      "aria-label={option.title ?? `${label}: ${option.label}`}",
    );
  });

  it("keeps the motion timeline usable at its minimum canvas width", () => {
    expect(motionTimelineSource).toContain("zd-design-motion-grid");
    expect(uiSource).toContain(".zd-design-motion-grid");
    expect(motionTimelineSource).toContain("designMotionPlaybackStartOffset(");
    expect(motionTimelineSource).toContain('aria-label="More motion settings"');
  });

  it("retains an unsaved motion draft by exact layer across selection changes", () => {
    expect(motionTimelineSource).toContain("motionDraftCache");
    expect(motionTimelineSource).toContain("sessionOwnerKey");
    expect(source).toContain("sessionOwnerKey={motionOverlayOwner}");
  });

  it("returns the one-shot text tool to Select after entering or cancelling inline editing", () => {
    expect(source).toContain("finishInlineTextTool");
    expect(source).toContain("cancelInlineTextEditing");
    expect(source).toContain("event.detail > 1");
  });

  it("supports Figma-style frame and text insertion without per-keystroke React state", () => {
    expect(source).toContain(
      'type DesignCanvasTool = "select" | "frame" | "text"',
    );
    expect(source).toContain("startFrameCreation");
    expect(source).toContain("startTextInsertion");
    expect(source).toContain('event.key.toLowerCase() === "f"');
    expect(source).toContain("contentEditable");
    expect(source).toContain("previewDesignNodeTextTransient");
    expect(source).not.toContain(
      "setInlineTextEdit((current) =>\n                        current ? { ...current, draft } : current,",
    );
  });

  it("separates text selection, text editing, empty-canvas insertion, and deletion intent", () => {
    expect(source).toContain("editingThisElement");
    expect(source).toContain("startCanvasTextInsertion");
    expect(source).toContain("onDeleteFrame");
    expect(source).toContain("designResizeStyleAxes");
  });

  it("does not let invisible spacing hit regions swallow nested-text double clicks", () => {
    expect(source).toContain("blocksDesignCanvasDoubleClick(");
    expect(source).toContain(
      'control.closest("[data-design-inline-spacing]") === null',
    );
  });
});
