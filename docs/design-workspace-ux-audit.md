# Design workspace interaction audit

> Status: implemented baseline and active product contract, 2026-08-10.

Zeros should borrow the interaction quality of mature design tools without
copying another product's chrome. The target is a source-backed design surface
where selection, layers, direct manipulation, properties, tokens, and motion
all describe the same exact document state.

## Research basis

This pass used Figma's official material as the primary comparison set:

- [Figma Motion announcement](https://www.figma.com/blog/introducing-figma-motion/),
  [Motion overview](https://www.figma.com/motion/), and the
  [Motion plugin API](https://developers.figma.com/docs/plugins/api/Motion/)
  informed the millisecond timeline, property tracks, editable easing,
  presets, canvas paths, and inspector keyframe actions.
- [Selecting layers and objects](https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects)
  and the [Layers panel guide](https://help.figma.com/hc/en-us/articles/360039831974-View-layers-and-assets-in-the-Layers-Panel)
  informed selection hierarchy, deep selection, hover feedback, visibility,
  and tree navigation.
- [Adjust alignment, rotation, position, and dimensions](https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-dimensions-rotation-and-position)
  informed full-edge horizontal/vertical resize hit regions while retaining
  minimal visible handles; [prototype animations](https://help.figma.com/hc/en-us/articles/360040522373-Prototype-animations)
  reinforced keeping playback, duration, and easing inside an explicit motion
  workflow rather than letting animation repaint the editing canvas at rest.
- [Grid auto-layout flow](https://help.figma.com/hc/en-us/articles/31289469907863-Use-the-grid-auto-layout-flow)
  [horizontal and vertical auto-layout flows](https://help.figma.com/hc/en-us/articles/31289464393751-Use-the-horizontal-and-vertical-flows-in-auto-layout),
  and [auto-layout properties](https://help.figma.com/hc/en-us/articles/360040451373-Explore-auto-layout-properties)
  informed hover-revealed padding/gap controls, fixed-versus-Auto spacing,
  grid tracks, flow, sizing, and alignment organization.
- [The UI3 redesign](https://www.figma.com/blog/our-approach-to-designing-ui3/),
  [Properties panel overview](https://help.figma.com/hc/en-us/articles/360039832014-Design-Prototype-and-view-Code-in-the-Properties-Panel),
  [frame dimensions](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma),
  and [constraints](https://help.figma.com/hc/en-us/articles/360039957734-Apply-constraints-to-define-how-layers-resize)
  informed the inspector hierarchy: selection identity first, layout-related
  controls together, common values visible, and independent/advanced values
  behind local progressive disclosure.
- [Guide to text](https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design),
  [frames](https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma),
  [design toolbar](https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar),
  and [keyboard access](https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard)
  informed one-shot `T`, `F`/`A`, and `V` modes; click-versus-drag creation;
  inline text entry; exact drawn frame geometry; and Escape restoration.
- [Adjust your zoom and view options](https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options)
  informed one focal-point-preserving zoom path for trackpad pinch/stretch and
  Cmd/Ctrl-wheel, custom deep zoom, and fit commands instead of device-specific
  sensitivity or range limits.
- [Text properties](https://help.figma.com/hc/en-us/articles/360039956634-Explore-text-properties),
  [text resizing](https://help.figma.com/hc/en-us/articles/27378154668951-Adjust-text-dimensions-and-resizing),
  [strokes](https://help.figma.com/hc/en-us/articles/360049283914-Apply-and-adjust-stroke-properties),
  [effects](https://help.figma.com/hc/en-us/articles/360041488473-Apply-shadow-or-blur-effects),
  and [blend modes](https://help.figma.com/hc/en-us/articles/360040667874-Use-blend-modes-to-create-unique-effects)
  informed independent border/corner controls, typography grouping, and the
  distinction between layer blend, fill blend, effects, and clipping.
- [Variables, collections, and modes](https://help.figma.com/hc/en-us/articles/14506821864087-Overview-of-variables-collections-and-modes)
  informed the theme mode matrix, inherited values, variable types, and mode
  preview.
- The [CSS Box Alignment specification](https://www.w3.org/TR/css-align-3/)
  informed the distinction between an authored `gap` and the larger visible
  gutter produced by `space-between` distribution.
- [Keeping Figma Fast](https://www.figma.com/blog/keeping-figma-fast/),
  [Figma's incremental frame loading](https://www.figma.com/blog/incremental-frame-loading/),
  [dynamic editable-file loading](https://www.figma.com/blog/speeding-up-file-load-times-one-page-at-a-time/),
  and [Improving performance in the Layers panel](https://www.figma.com/blog/improving-performance-in-the-layers-panel/)
  informed the local-first commit path, retained last-confirmed pixels,
  dependency-local text/style invalidation, bounded workspace/frame caches,
  virtualized Layers work, and changed-row render boundaries.
- [Figma rendering powered by WebGPU](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/)
  reinforced treating the camera as explicit renderer input, batching work,
  reusing exact resources, measuring across devices, and retaining a runtime
  fallback. Zeros keeps HTML/CSS as its authored medium rather than pretending
  an iframe is Figma's custom WebGPU scene graph.
- [Realtime editing of ordered sequences](https://www.figma.com/blog/realtime-editing-of-ordered-sequences/)
  reinforced the rule that speculative local feedback is immediate while the
  authoritative source transaction and generation handoff remain ordered.
- React's guidance for [`memo`](https://react.dev/reference/react/memo) and
  [`useSyncExternalStore`](https://react.dev/reference/react/useSyncExternalStore)
  informed stable scalar props and the exact-owner playhead store. The browser
  [rendering performance model](https://web.dev/articles/rendering-performance)
  informed keeping pointer and animation-frame work out of broad React trees.
- Chromium's [iframe compositing architecture](https://www.chromium.org/developers/design-documents/oop-iframes/oop-iframes-rendering/)
  and the browser [`FontFaceSet.ready`](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/ready)
  contract informed the live document-buffer handoff: an incoming iframe is
  not revealable until its font loading and layout have settled and its child
  compositor has had presentation frames to raster the result.
- Chromium's [GPU accelerated compositing model](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)
  explains why a transformed iframe can temporarily expose a magnified layer
  backing: painting and transform compositing are separate phases. It informed
  synchronous camera variables, gesture-local chrome, and final-scale viewport
  reraster instead of a permanent `will-change` bitmap.
- Paper's [connected-canvas rationale](https://paper.design/blog/a-real-space-to-design-in-the-age-of-agents)
  and [build log](https://paper.design/build-log) reinforced keeping real HTML
  and CSS live, making zoom/detail levels explicit, and treating text, images,
  page switching, and large-file rendering as continuous quality work—not as
  reasons to replace the source surface with a static mock.

The transferable principles are immediate visual feedback, one semantic
selection across every surface, discoverable direct manipulation, compact
progressive disclosure, and editability after applying an automation or
preset.

## Interaction contract

| Surface              | Required behavior                                                                                                                                                                                                                                                                                                                      | Performance and correctness invariant                                                                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas selection     | `#0C8CE9` semantic outline that traces the element's own rotated box, white high-contrast corner handles, size label, screen-aligned constraint guides to the pinned parent edges, rotation from outside each corner, and a movable rotation origin; top-level frames use four visible corner handles and full-edge resize hit regions | Strokes and controls retain their screen size at every supported zoom. Selection geometry comes from the element's untransformed border box plus its accumulated rotation, never the axis-aligned bounding box a rotation grows around it |
| Canvas navigation    | Trackpad pinch tracks Chromium's synthesized `exp(-deltaY/100)` pinch scale one-to-one; Cmd-wheel keeps its flatter scroll-delta curve; both preserve the focal point; ordinary two-finger wheel pans                                                                                                                                  | Normalize pixel/line/page deltas, accumulate direct-DOM gesture state without losing burst events, settle one store update, and clamp the persisted range to 1%–25,600%                                                                   |
| Canvas creation      | `F`/`A` enters a crosshair frame tool; click creates 100×100 and drag creates the exact world-space rectangle; `T` enters a crosshair text tool with click auto-width and drag fixed-box modes                                                                                                                                         | Gestures use one inverse pan/zoom transform, paint a host-side draft synchronously, commit initial geometry atomically, and return to Select on completion or cancellation                                                                |
| Inline text          | Double-click selected or nested text, press Enter on a selected text leaf, or target it with `T`; type in place, paste plain text, preserve line breaks, commit on blur/Cmd/Ctrl+Enter, cancel on Escape                                                                                                                               | Keystrokes stay in one uncontrolled editor and a latest-wins transient runtime queue; no broad React state or iframe navigation occurs per character; cancellation restores exact text                                                    |
| Layers               | Every frame independently foldable, its tree indented per depth from its frame row, neutral selected fill, per-row visibility, keyboard travel, layer hover reflected on canvas                                                                                                                                                        | One virtualized row list across frames; coalesce uncached hover reads to active + latest; match hover and selection by frame; a visibility write republishes the runtime generation                                                       |
| Style inspector      | Position, size, layout, fill/border, typography, effects, transform, transition, motion, and CSS in compact sections. A typed value is a draft: `Enter` applies it, `Escape` restores the focus-time baseline, blur commits; label scrubs, sliders and colour drags stay live                                                          | Preserve authored-vs-computed state; typing never writes the canvas, the commit paints once before the source round trip settles, and Escape restores the exact baseline                                                                  |
| Auto layout and grid | Line-first padding/gap manipulation, hover/focus-only values and hatching, Shift snapping, Option mirroring, grid track overlays and structured track/flow/alignment controls                                                                                                                                                          | Keep controls at constant screen size; paint lines synchronously; derive gaps from rendered direct children in the same lean measurement that applied the spacing; one flight per gesture; commit one source transaction on release       |
| Theme editor         | Non-modal draggable mode matrix, variable search/type filters, inherited values, CSS import, variable/theme creation, live mode preview                                                                                                                                                                                                | Keep canvas, layers, and inspector interactive; constrain the editor and its scroll/wheel handling to the viewport                                                                                                                        |
| Motion               | Empty-by-default node-local tracks, property diamonds, millisecond ruler, precise scrub/playback, keyframe drag/add/remove, presets, custom easing, save/delete, and canvas paths                                                                                                                                                      | Key drafts, definitions, and preview state by exact workspace/frame/node owner; permit playback only in explicit Motion mode; unsupported transforms must not create misleading paths                                                     |

## Continuous rendering and cache contract

The canvas document, Style inspector, Layers tree, theme window, and Motion
timeline are persistent editing surfaces. An authored value change must not be
implemented as a loading transition.

- Visual-only engine writes are adopted by the already-mounted sandbox before
  the aggregate workspace snapshot is published. The private runtime channel
  advances from the previous 24-character source generation to the confirmed
  next generation atomically, so React never observes a new source key backed
  by an old runtime.
- Motion saves mirror their bounded `@keyframes` definitions and animation
  declarations into one stable runtime stylesheet. Theme edits do the same for
  base or named-mode custom properties across every connected frame. A commit
  patches only the affected CSSOM rule or declaration; unrelated token,
  animation, text-node, stylesheet, and rule identities survive. Bounded
  definition maps prevent stale style elements or rules from accumulating.
- Runtime preview and commit mirror the same source decision: an existing
  inline declaration remains inline, while one unambiguous top-level
  `[data-oid]` rule is previewed and committed through that CSS rule. Priority
  is preserved, including `!important`, and Escape or teardown restores the
  exact prior declaration.
- Ordinary style commits declare their layer hierarchy unchanged. The runtime
  sends a lightweight snapshot without cloning a 20,000-node tree, and the
  renderer retains the exact previous tree reference while rebasing bounded
  node details to the new generation. `display` and `visibility` edits take the
  full-tree path.
- Structural and text edits still load an authoritative composed document.
  They use a bounded pair of live iframe buffers: the displayed document keeps
  supplying its exact Chromium-rendered glyph pixels while one immutable
  incoming generation loads underneath it. The incoming runtime waits for
  fonts and layout, completes its private handshake, applies the current theme,
  refreshes selected-node readback, and receives two compositor frames before
  one React commit swaps buffer roles and removes the outgoing document. A
  raster/blank cover is reserved for a genuine cold load where no live document
  exists. Rapid A → B → C updates replace only the unpainted incoming buffer.
- Inline text keystrokes are a narrower exception to the structural handoff.
  One host `contenteditable` owns caret, selection, composition, and the draft;
  a serialized latest-wins runtime preview mutates only the exact direct text
  node. It retains the authored baseline for Escape/teardown and does not
  publish the speculative draft through the canvas React store. Commit emits
  one Foundation transaction for existing text, including `pre-wrap` only when
  a newly authored line break needs it. Newly inserted text appends one escaped,
  stable-ID HTML node and keeps the host editor painted until the incoming
  source generation has laid out and selected that node.
- Glyph suppression uses Chromium's transient text-fill paint rather than
  changing semantic `color`, so a runtime read during editing cannot make the
  next host editor transparent. Commit teardown observes the actual displayed
  iframe buffer—not the earlier incoming-ready readback—and hides the host
  glyph in the same DOM microtask as the swap. This prevents both a blank
  interval and simultaneous host/runtime copies. Expected exact-source races
  while persisting selection retain local semantic selection and are retried
  naturally by the next runtime-ready reconciliation.
- Glyph ownership is handed over in one direction only: the edit carries its
  start-of-edit runtime details, the host editor mounts from them in the same
  React commit that begins editing, and the mounted editor is what requests
  runtime glyph suppression. Suppression can therefore never precede a painted
  editor — the failure that previously left text invisible whenever selection
  readback was slow, raced a generation handoff, or failed outright. The worst
  degraded state is a brief double-paint of identical glyphs. The editor also
  paints the node's exact resolved color from those details, so entering
  editing can no longer recolor text through the missing-details fallback.
- A new text draft inherits only inherited CSS — typography, color, alignment,
  wrapping — from its insertion parent. The parent's box constraints (padding,
  borders, box sizing, min/max sizes) are not inherited CSS, never reach the
  committed node, and are excluded from the editor, so what is typed is the
  purely-text node that commit produces, at the same position and measured
  size.
- The editing host is plaintext-only. Range-based paste strips rich markup but
  preserves authored line breaks, repeated input/composition notifications are
  coalesced by draft value, and a blur during IME composition defers the single
  commit until `compositionend` so partial text is never published.
- Runtime snapshot publication is referentially stable. Reapplying the current
  theme returns the last confirmed snapshot, and publishing that exact snapshot
  is a no-op, preventing duplicate React commits during document readiness.
- Camera gestures paint one world transform together with numeric zoom and
  inverse-zoom CSS variables. Selection strokes, handles, labels, motion paths,
  guides, and inline text boundaries therefore observe the exact imperative
  camera frame rather than the last debounced React viewport. Padding, gap,
  grid, and distance tooling is hidden only while camera input is active and
  returns after final geometry has reconciled.
- Frame names are plain, inverse-scaled text rather than toolbar buttons. Their
  maximum screen width is the frame's projected width, so they remain readable
  while continuously zooming and ellipsize instead of leaking beyond a tiny
  frame.
- Above the deep-zoom threshold (600%, where Chromium stops re-rasterizing
  magnified iframe textures at device fidelity on Retina displays), the
  authoritative iframe remains mounted while a bounded visible crop is
  rerasterized at a two-times backing resolution. Captures are camera-keyed and
  decoded before publication. A stale crop keeps painting after the camera
  settles at a new zoom or pan: its geometry is authored in frame-local
  coordinates, so the world transform keeps it glued in place — scaled like the
  previous level of a map tile — until the decoded replacement swaps pixels in
  one paint. Its two-times backing means one further octave of zoom-in stays at
  or above device resolution before any softness is visible. Hiding stale
  crops (the previous contract) flashed compositor-magnified iframe pixels for
  the full clone → SVG rasterization → encode → decode round trip on every
  settled step, which read as per-step re-rendering with position shifts.
- Viewport rasterizations are serialized per frame with a latest-wins queue:
  each capture clones and re-renders the whole document inside the frame, so a
  stepped zoom would otherwise stack redundant clones behind the newest camera.
  PNG encoding runs through `canvas.toBlob` (off the frame's main thread in
  Chromium) so live previews and authored animations do not stall during
  multi-megapixel encodes; `toDataURL` remains only as a fallback. The
  viewport-capture budget (9 MP, 8192 px max dimension) covers a full Retina
  viewport at the requested 2× backing; these tiles live only in renderer
  memory and never cross the persisted-thumbnail wire cap.
- Motion and Theme are memoized persistent surfaces with stable,
  camera-agnostic callbacks. A viewport settle reconciles canvas geometry
  without executing either heavy editor tree.
- Motion editor identity is workspace + frame + node, not source revision.
  Source commits therefore do not discard an unsaved draft. Playback ticks use
  a bounded scalar exact-owner store and update only the small path overlay;
  they do not reconcile the canvas frame map at 60 Hz.
- Layer hover readback updates a frame-local hover overlay subscriber. The
  canvas parent does not subscribe to hot hover identity, while Layers keeps
  its existing virtual window and active/latest read coalescing.
- The two most recently visited design workspaces remain mounted as an MRU
  deck. Inactive owners are invisible, `inert`, and receive `surfaceActive=false`,
  which gates reads, captures, polling, shortcuts, focus, and measurement.
- Inspector commit/preview callbacks read the latest exact owner through refs
  and keep stable identities. Memoized scalar fields can skip unrelated style
  updates even though the inspector receives a new authoritative node object.
- Local authored mutations are ordered per workspace. A queued operation may
  rebase a stale requested source/revision only when the current confirmed
  generation is a bounded descendant produced by this renderer; an unrelated
  external edit still fails its compare-and-swap check. Watcher echoes remain
  deferred until the whole local queue has adopted its final generation.
- Compatibility style, text, token, asset, and frame-geometry replies carry
  their exact authored before/after revision receipt. A following Foundation
  transaction can therefore rebase without another bridge read. Sibling frame
  documents that share changed files refresh lazily through their current
  exact source key; immutable prior-generation Foundation entries are neither
  invalidated nor allowed to repaint the active inspector.
- Speculative values are keyed by workspace + frame + node + property. A
  failed or completed width write cannot clear a newer width preview or an
  in-flight height preview. Runtime rejection, source settlement, and Escape
  each remove only the exact values they own.

## Style property interaction matrix

The visual inspector covers the common web-design surface and the CSS section
remains the explicit escape hatch for any other valid declaration. Every row
below follows one input contract: show browser-computed feedback even when the
value is not authored, preview against the mounted runtime while typing,
repaint affected selection/spacing geometry, restore on Escape, commit once,
then read back the confirmed generation without remounting the document.

| Group                 | Direct controls                                                                                                                                                                                | Layout readback and notable edge cases                                                                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout                | position and four offsets; width/height; min/max; aspect ratio; box sizing; visibility/overflow; object fit; cursor/pointer behavior                                                           | Bare spatial numbers become pixels. Static offsets promote to relative positioning. Content-box resize translates outer-box deltas back to CSS dimensions.                                            |
| Auto layout           | block/flex/grid; flow/wrap; alignment/distribution; gap/row/column gap; explicit and implicit grid tracks; padding/margin; item grow/shrink/basis/order/self/grid placement                    | Any value that can reflow descendants performs bounded browser readback so the blue box and pink child gaps share one geometry. Auto-distributed flex gaps become fixed only after direct gap intent. |
| Appearance            | opacity; layer and fill blend; isolation; fill; border width/style/color; independent side widths and corners; outline                                                                         | Layer blend and background blend remain separate. Authored shorthand provenance fills affected side fields without falsely marking unrelated computed values as authored.                             |
| Typography            | family/style/weight/stretch; size/line height/tracking/word spacing/indent; color/alignment/case/decoration; white-space/text wrap/overflow; word breaking; vertical/writing mode; hyphenation | Font and wrapping properties are layout-producing. Width/height overlays wait for browser glyph/layout readback rather than estimating text boxes.                                                    |
| Effects and transform | box/text shadow; filter/backdrop filter; clip path; structured transform; transform and perspective origins                                                                                    | Effects preview without broad tree reads. Transform and perspective trigger exact rect readback; unsupported motion-path units remain explicit rather than fabricating coordinates.                   |
| Transition and motion | property/duration/delay/easing; node-local keyframes in explicit Motion mode                                                                                                                   | Bare timing numbers become milliseconds. Authored animation stays suspended outside Motion mode, and property diamonds address only the selected frame/node owner.                                    |
| CSS                   | bounded declaration-list paste with computed export                                                                                                                                            | Selectors/nested rules are rejected; property/value validation remains source-authoritative. The runtime currently returns every one of the inspector's 102 exported properties.                      |

## Implemented behavior

### Frame and text creation

- Frame and Text are explicit canvas modes with pressed toolbar state,
  crosshair cursors, and `F`/`A`, `T`, and `V` shortcuts. Space-pan keeps its
  existing priority. Escape cancels any in-progress creation gesture, hides the
  draft immediately, and returns to Select.
- Frame drag uses viewport bounds plus the current pan/zoom snapshot to derive
  exact world coordinates in every drag direction. The draft rectangle and
  dimensions paint directly during movement. Release creates the frame with
  `x`, `y`, `w`, `h`, and stacking order in the original engine mutation, so a
  default-sized intermediate frame never flashes. A click follows the mature
  editor convention and creates a 100×100 frame at that world point.
- Text click first performs a deepest runtime hit: editable text opens in place;
  otherwise it creates auto-width text at that point. Text drag always creates
  a fixed box using the exact frame-local rectangle. A new node receives a
  renderer-generated stable ID, safe escaped markup, source-relative
  coordinates, and immediate caret focus.
- Selected and nested text both support double-click editing. The second press
  is handled before a selection refresh can replace the browser click target,
  while the ordinary double-click handler remains an accessibility/event
  fallback. Enter edits a selected text leaf. Editing preserves computed type
  styling, multiline input, IME composition, spellcheck, and plain-text paste;
  the draft is bounded to 10,000 characters.
- Existing text mirrors each draft into the live runtime without remounting the
  editor, canvas frame, iframe, inspector, or timeline. Escape restores the
  exact authored runtime text and canvas focus. Cancelling newly inserted text
  restores the prior frame/additive layer selection. Blur or Cmd/Ctrl+Enter
  persists once; an empty new draft is discarded without a source write.
- Runtime text readback preserves the exact direct text up to the shared
  10,000-character editor bound; names remain separately summarized. The host
  mirrors fixed, auto, min/max-content, and fit-content width behavior plus the
  containing block's available width, so a content-sized label grows exactly
  once instead of wrapping inside its pre-edit rectangle while the iframe grows
  underneath it.

### Canvas and Layers

- Dashed guides from a selection are constraint indicators: they reach only the
  parent edges the element's own CSS pins it to, which is what Figma calls a
  constraint expressed in the properties HTML actually has — `position` plus the
  authored `left`/`right`/`top`/`bottom` offsets. Pinning both sides of an axis
  stretches with the parent and draws both runs; pinning neither leaves the box
  to document flow, which anchors at the start edges and draws top and left.
  Authored provenance decides the side, because a relative box computes both
  offsets of an axis symmetrically (`top: 10px` computes `bottom: -10px`). The
  runs live in frame space beside the rotated overlay rather than inside it and
  measure from the selection's bounding box, so a turned element keeps
  screen-aligned constraint lines instead of firing them off at its own angle.
- Selection visuals use a dedicated `Design workspace` semantic-token group.
  Selection and padding are `#0C8CE9`, gaps are `#F531B3`, and spacing markers
  use an exact white border. Outline, handles, labels, hover outlines, marquee,
  guides, and motion affordances share the same selection language.
- Top-level frames show only the four corner resize handles at rest. Invisible
  constant-screen-size hit strips cover all four outer lines, so hovering the
  top/bottom or left/right boundary exposes `ns-resize` or `ew-resize` and uses
  the same anchored resize math. Element selections retain the same four corner
  squares and full-edge hit strips.
- A selected element carries no identity-and-actions pill. Its name and tag
  belong to Layers and the inspector; duplicate, delete, and text editing keep
  `⌘D`, `⌫`, double-click, and `Enter` on a text leaf.
- Rotation has no button of its own. A constant-screen-size zone just outside
  each corner shows a rotation cursor — two opposing curved arrows around the
  point being turned — aimed the way the drag will turn, and dragging turns the
  element about its own origin with `Shift` snapping to 15°. Because CSS cannot
  transform a cursor image, the angle is baked into an inline SVG quantized to
  15° so the browser reuses a small set of decoded images.
- Releasing a rotation holds the released angle. The transient preview keeps the
  element turned until the committed generation republishes it, so repainting
  the pre-gesture angle on pointer-up is what flashed the outline upright for a
  frame and then jumped it back; only a cancelled gesture restores it.
- The rotation origin is authored `transform-origin`, not editor state, so it
  survives reloads and appears in the inspector's Transform section. Its marker
  is a reticle at the pivot that snaps to the nine standard anchors while
  dragging; `⌘`/`Ctrl` suspends snapping and double-click returns it to the
  center. Moving the pivot of an already-transformed element authors the
  compensating `translate()` that keeps the element itself from jumping, and the
  marker only accepts the pointer after the pointer has entered a rotation
  corner — it sits where a drag means "move this element" and a double-click
  means "edit this text".
- Like every other selection affordance, the origin marker holds one screen
  size, which means it grows relative to the element as the camera pulls back.
  Below six times its own hit box — roughly 108 screen pixels of selection, or a
  48×30 element under about 2.5× zoom — it would cover the element it belongs
  to, so it is not drawn at all and zooming out far enough always retires it.
- A rotated selection outlines the element's own box: the overlay is placed at
  its untransformed border box, anchored on the pivot (the one point a rotation
  cannot move), and turned by the accumulated rotation, so handles, size label,
  padding, and gap affordances all turn with it and a rotation gesture repaints
  nothing but one transform. Resize travel rotates into the element's own axes,
  and the authored offset cancels the drift CSS introduces by growing an element
  away from its top-left corner while turning it about a size-relative pivot. A
  rotated selection does not snap to peer edges it no longer shares.
- The frame runtime reports that geometry, because only the document can resolve
  it: `box` carries the untransformed border box, the rotation and scale
  accumulated from the element and every ancestor, and the pivot as a fraction
  of the box. Chains of translation, z-rotation, and positive scale are exact;
  skew, mirroring, and 3D transforms report no rotation and keep the
  axis-aligned bounding box rather than claiming an orientation no rotated
  rectangle has. Older runtimes omit `box` and the canvas falls back to that
  same bounding box.
- Inverse zoom scaling keeps the selection handles and labels usable when the
  document is zoomed out. Motion-path strokes use one inverse scaling strategy,
  avoiding double compensation at low zoom.
- Pinch and Cmd-wheel share one focal-point-preserving exponential curve and
  one ref-owned viewport accumulator, but each input device gets the rate its
  delta scale encodes. Chromium synthesizes a trackpad pinch as a ctrl-modified
  wheel event whose `deltaY` approximates `-100·ln(scale)`, so the canvas
  applies `exp(-deltaY / 100)` and content tracks the fingers one-to-one — the
  de facto contract across engines and canvas tools (d3-zoom multiplies its
  wheel rate by ten under `ctrlKey` for the same reason). Command-scroll keeps
  the flatter `0.002`-per-pixel curve tuned for scroll deltas an order of
  magnitude larger per event. A ±0.3 exponent clamp keeps one physical
  ctrl-scrolled mouse notch (|deltaY| ≈ 120) at a familiar ~1.35× step. Every
  high-frequency delta paints the world transform immediately around the
  pointer, then an 80 ms idle boundary publishes a single workspace-owned
  viewport update. Fit and toolbar zoom cancel an unfinished wheel settlement
  so a late timer cannot snap the canvas back. The supported 1%–25,600% range
  covers overview and glyph-detail work.
- Layer rows expose one indent step per depth below the frame row that owns
  them, neutral selected and hovered fills, node type, and visibility, while
  preserving the existing bounded virtual window and roving tab stop. A row
  with nothing to disclose reserves the chevron's column instead of drawing
  one, and hiding a layer republishes the runtime generation so the row fades
  and the same control shows it again.
- Row fills span the panel and indent only their content, so a selection and
  every row it owns paint one rounded container: the run's first row rounds its
  top, its last row rounds its bottom, and no gap or radius interrupts the
  middle. Fills carry no transition — animating them left an outgoing frame's
  block fading in place while the incoming one faded in above it.
- Disclosure is frame-owned state, bounded per workspace and frame and pruned
  with its workspace. Rows default to folded; a selection publishes the path
  that reveals its row in the same transition, and the user stays free to fold
  those containers again. Any number of frames stand open at the same time, each
  keeping its own shape: only its chevron folds it, selecting a frame neither
  opens nor closes anything, and a frame the user opened stays open while they
  work in another one. Collapse all closes every frame and container the
  workspace holds and is inert only once nothing anywhere is open.
- The panel is one tree: frame rows, the layer rows of every open frame, and a
  per-frame pending row share a single fixed-height row list, so virtualization,
  arrow travel, the roving tab stop, and the selection block all work across
  frame boundaries. Rows are addressed by frame-scoped keys because two
  documents may legitimately author the same node id. A frame the panel holds
  open is a live-runtime demand alongside the selection, so its tree cannot
  stall while it sits off-canvas.
- Hover readback publishes only when workspace, frame, source version,
  generation, and current hovered node still agree. Rapid traversal performs
  at most the active read and the latest pending read.
- The Option measurement overlay follows the live modifier rather than one
  keydown: it appears whichever surface owns focus (a Layers row is the ordinary
  case), never while an editable field is the target, and clears on release,
  window blur, or the document becoming hidden.

### Layout and style authoring

- Flex and grid selections expose four compact padding lines only while the
  pointer is inside that selected container. Every marker is centered in its
  padding band; a zero-value marker remains addressable exactly on its element
  edge. A value and single blue hatched side appear only over the active
  padding handle, while gap handles use independent pink labels and hatching.
  The redundant floating layout badge and permanent numeric chips are absent.
  Shift snaps to 8 px, Option mirrors the opposite padding,
  Option+Shift applies all four sides, and Escape, pointer cancellation, or
  window blur restores the baseline.
- Gap lines are derived from the rendered boxes of direct in-flow children.
  Horizontal, vertical, wrapped, and grid layouts therefore place hit targets
  in each real inter-item band rather than at the arbitrary center of the
  container. Absolute/fixed children are excluded and a constant-screen-size
  hit target keeps a zero-width gap discoverable.
- A gap's forgiving pointer target and visible pink band are separate
  geometries. Hatching covers only the exact rendered inter-item space, while
  the invisible target may expand to 18 screen pixels. Container resizing
  streams one latest-wins runtime preview, then repaints the selection,
  padding centers, and direct-child gap bands from the same browser layout;
  cancellation restores all three geometries together.
- Pointer movement writes padding line geometry through local CSS variables in
  the same animation frame. One coalesced sandbox preview then reconciles the
  selection box, size label, and all existing child-gap bands from a single
  aggregate runtime read. This avoids React commits and per-child requests on
  the pointer path while keeping hug-sized containers and their children live.
- `space-between` is the CSS representation of an Auto-distributed flex gap:
  increasing `gap` alone cannot move children while free space remains. A
  direct gap drag explicitly converts only that flex axis to `flex-start` and
  authors the fixed gap atomically; cancellation restores Auto distribution.
- Direct-child geometry is keyed by frame, source generation, node, and theme.
  The last exact-owner boxes remain visible while a runtime revision
  revalidates, and all reads and rendered controls are bounded.
- Grid selections visualize computed columns and rows with labels. The
  inspector exposes explicit/implicit tracks, flow/dense behavior, row and
  column gaps, item alignment, and content distribution.
- Every standard style field can promote its current value into a motion track.
  Bespoke fill, transform, box-shadow, and text-shadow editors expose the same
  keyframe affordance.

### Themes

- Variables can be filtered by inferred color, length, number, time, angle, or
  other type, with live counts and modes represented as directly selectable
  headers.
- Base and named-mode values remain visible in one matrix. Missing named-mode
  values are explicitly inherited rather than copied, preserving the token
  model.
- Theme mode preview changes runtime metadata without blocking element edits,
  Layers interaction, or canvas tools.

### Motion

- The bottom timeline owns a millisecond ruler, exact current-time input,
  play/pause, effect range, collapsible layer/property hierarchy, draggable
  diamonds, selected-point time/value editing, and source-backed save.
- A layer with no authored `animation-name` opens with no tracks or placeholder
  opacity keys. New keyframe names include a deterministic frame+node owner
  hash, preventing two frames that reuse a portable node ID from overwriting
  one another's `@keyframes` definition.
- Endpoint diamonds and the final property track can be deleted. Clearing an
  unsaved draft returns to the true empty state; deleting saved motion detaches
  animation declarations from only the selected node while leaving a shared
  definition safe for any other intentional consumers.
- Authored CSS animations and transitions are suspended in the design runtime
  before a frame becomes revealable and after style/theme commits. The runtime
  preserves authored computed metadata for the inspector, but only the
  explicit `previewMotion` path may animate, and the host rejects that path
  whenever the bottom-bar Motion mode is closed.
- New property tracks receive boundary keyframes so an inspector diamond never
  creates an invalid one-point animation. Existing tracks receive only the
  requested playhead point.
- Fade, slide, scale, blur, pulse, and spin presets generate ordinary editable
  CSS keyframes. Editing any generated value returns the preset control to
  `Custom`.
- Easing accepts standard names and authored CSS functions such as
  `cubic-bezier(...)` and `steps(...)` instead of limiting authors to a fixed
  menu. Browser CSS validation prevents an invalid timing function from being
  saved, and parenthesis-aware list parsing preserves functional easing commas
  when existing animation shorthands are loaded.
- Translation keyframes produce selectable canvas path points and an exact
  timeline seek. Relative or unsupported translation units return no path;
  scale/rotate-only motion does not invent a zero-length one.

## Bugs and edge cases closed by this pass

### Inline manipulation: the overlay and the element are one object

- A gesture authored `left` and `width` (or `top` and `height`) with two
  independent `Math.round` calls from fractional layout bases, so the edge a
  west/north resize is supposed to hold still moved a whole CSS pixel back and
  forth — twice per pixel of pointer travel, and 8 device pixels at 8× zoom. The
  two **edges** of an axis are now quantized instead of the offset/size pair
  (`designAuthoredResizeAxis`), and the overlay is painted from those same
  integers, so an untouched edge does not move and the outline never sits half a
  pixel off the element.
- Each gesture frame cost two serialized round trips into the sandbox — a full
  node-details call that waited for an animation frame before measuring, then a
  child enumeration that ran full details for every direct child — so the element
  updated at 15–30 Hz while the outline followed the pointer at display rate. The
  gesture path now has its own runtime method (`previewGeometry`) that applies the
  styles and measures in the same task, returns only what the canvas paints from,
  and brings the container's children along in the same answer.
- `elementForOid` rebuilt the entire oid map with a document `TreeWalker` on every
  request — one to three full walks per gesture frame. The map is now invalidated
  by the mutation observer that already knows when the DOM changed.
- The first preview of each property re-walked every rule of every stylesheet to
  find the authored declaration behind it, which is a five-figure number of
  selector serializations at the exact moment a drag begins. Those rules are now
  indexed by oid once per generation.
- `document.getAnimations()` ran on every preview write. The document is now
  cleared once when a preview session opens; later writes only cancel motion on
  the element they touched.
- The selection overlay read its own `getBoundingClientRect()` in a `pointermove`
  handler to decide one hover attribute, forcing a host layout pass on every
  pointer event mid-drag. A full-bleed hover zone and `:has()` answer it in CSS.
- An imperative label paint used `replaceChildren`, which detaches the text node
  React rendered; after the first drag the size label silently stopped following
  React and froze at its last predicted value. Labels now render as one
  interpolated child and are painted through `firstChild.nodeValue`.
- A gap handle hidden for one transient frame stayed hidden after the commit,
  because React never wrote `visibility` back. React owns that property now.
- Holding Option during a resize (its from-center modifier) unmounted the
  constraint guides the gesture was painting into, and the overlay list was keyed
  by array index, so a reorder could hand a running gesture a detached node. Both
  are fixed.
- The rotation pivot drifted off the box during a resize and the angle readout
  tilted during a rotation, because only React placed them. The overlay paint
  carries them now.
- Pinch-zooming during a drag left the gesture dividing pointer travel by a stale
  zoom for the rest of the drag; gestures read the camera that is painted.
- A commit re-read the selection's children in full and up to 64 siblings
  individually — each a full document walk inside the sandbox — at the instant the
  pointer was released. Both now use the lean measurement.

- Text double-click either descended without entering an editor or raced a
  semantic selection refresh. The inline editor now starts on the second press
  for an already selected text layer and directly after a deepest nested-text
  hit.
- Text editing previously required a panel/source round trip, so characters
  could make the frame and glyphs reappear. Drafts now remain uncontrolled in
  the host and mirror into the existing runtime through an exact-node transient
  channel; the source changes once at commit.
- A canceled transient text preview could leave speculative characters in the
  iframe. The runtime retains and restores the exact authored text, including
  teardown and rapid-preview cases.
- Starting empty text cleared the current semantic selection permanently even
  when the gesture was canceled. The prior primary and additive selection is
  now restored atomically.
- Creating a frame at its default size and resizing it in a second write caused
  a visible jump, two generations, and a stale-write race. Initial geometry is
  now validated and authored in the create mutation itself.
- Screen coordinates were previously insufficient for drawing under pan and
  zoom. Frame creation uses one tested inverse viewport transform, while text
  boxes use the selected frame's rendered scale and clamp to its bounds.
- Newly inserted text could inject markup or collide with an existing node ID.
  Text is HTML-escaped and IDs use a renderer-owned stable prefix plus UUID.

- Expanded zero/thin gap hit targets also painted the pink hatching, making a
  small gap look much larger than its rendered child-to-child space.
- Resizing a selected flex/grid container repainted only its blue selection
  box; gap bands stayed at pre-resize child coordinates until a later React
  readback. Latest-wins preview geometry now moves them in the same gesture.
- Top-level frame selection hid midpoint handles but left no outer-line hit
  regions, so only corners could resize despite the visible bounding box.
- Every motion-free selection fabricated two opacity keys, making a new frame
  look as though another frame's motion had persisted.
- Default animation names used only the node ID. Reusing an ID in a different
  frame could address and overwrite the same global CSS keyframe definition.
- Endpoint and final-track delete controls were disabled, leaving two-point
  animations impossible to remove. Saved nodes also had no detach operation.
- Authored CSS animations continued running after style adoption and whenever
  Motion mode was closed, producing opacity/text repaint flashes that looked
  like canvas or React remounts.
- A fresh empty keyframe array could reset a cold motion draft on each render.
- A motion preview returned fresh node-detail objects and reset its own unsaved
  timeline edits.
- Rapid Layers traversal could issue an unbounded read for every crossed row.
- Reused node IDs could show a hover state from a different selected frame.
- Runtime refresh could replace a spacing handle mid-drag, leaving live numeric
  feedback painted into a detached node.
- Padding values changed while their lines remained frozen at the original
  computed edge.
- One permanent center chip represented `gap`, even when no child-to-child gap
  existed there; all four padding values and fills also stayed visible at rest.
- Flex `space-between` swallowed numeric gap changes, making a correctly
  applied preview appear broken.
- Fetching child geometry one element at a time would have introduced a layout
  read waterfall; gap tooling now uses one bounded aggregate request.
- Toggling Option during a padding drag could leave a stale opposite-side
  preview. Every preview now carries the complete transient padding baseline
  while the source commit authors only the sides requested at release.
- Applying inverse zoom and SVG non-scaling strokes together made paths too
  thick when zoomed out.
- Transform tracks containing only scale or rotation rendered stacked fake
  translation points.
- Inspector-created properties could be saved with only one keyframe.
- Timeline timing fields read a pooled React event from a deferred state
  updater, which could unmount the editor while customizing a preset.
- Every successful style transaction changed the iframe `src`, causing a full
  document navigation and a visible canvas reappearance.
- Two quick inspector commits reused the same stale `sourceVersion`; the first
  succeeded and the second produced “Design frame changed before the
  mutation.” All local writes now share an ordered, locally rebased CAS queue.
- Local lineage cannot rebase across an engine restart: a respawned engine
  re-composes every generation and authored revision, so after a crash or
  watchdog respawn every canvas edit — spacing drags, alignment clicks, text,
  tokens — was rejected with the dead-end “Re-read it and retry” toast, which
  read as the canvas glitching and snapping back. Stale-generation rejections
  are now self-healing: the mutation layer re-reads the workspace snapshot and
  replays the rejected write once against the freshly confirmed generation
  (compat ops carry the fresh `sourceVersion`; transactions mark the
  Foundation revision stale and re-open it). Only optimistic-concurrency
  rejections replay — the write was provably not applied — while
  transport-shaped failures, whose write may have landed, are never retried.
  Design caches also revalidate on every bridge reconnect boundary instead of
  waiting for the next rejection, and raw transport diagnostics (“Request
  timeout: WORKSPACE_REQUEST”, “Engine swapping — request aborted”) are
  translated into actionable canvas copy.
- A single-node compatibility edit advanced the authored Foundation revision
  without reporting that lineage, so an immediate multi-selection transaction
  could carry the pre-edit revision. Mutation receipts now promote the exact
  local lineage, while shared-file changes mark only sibling document
  revisions for a deduplicated current-key refresh.
- Multi-selection writes used a UI busy lock and silently dropped a second
  property edit. Each edit now enters the same ordered transaction queue while
  controls remain available for speculative input.
- Settling one property cleared the node's entire live-preview object, so a
  confirmed width could erase a newer height, padding, or gap preview. Preview
  publication and cleanup are now property-scoped and sequence-aware.
- Inspector dimensions accepted `320` visually but sent invalid CSS
  `width: 320`; spatial and timing fields now normalize bare values to `px` and
  `ms` consistently for preview and commit, while unitless properties remain
  unitless.
- Inspector input changed the iframe element but left the blue selection,
  size label, padding centers, and gap bands at their old geometry. The
  selection island now paints exact runtime details and performs one bounded
  child read only for layout-producing properties.
- Child geometry readback filtered against a stale React frame generation
  after hot adoption, hiding valid new gap coordinates. Transient reads follow
  the mounted runtime generation and still reject unrelated generations.
- A wide gap hit target could sit above the outer resize line, turning a
  bottom-edge resize into a gap drag at low zoom. A four-screen-pixel edge
  strip now has pointer priority while padding/gap controls retain their larger
  interior targets.
- Selects, segmented controls, and outer-frame dimension fields waited for the
  source round trip before moving pixels. They now paint the mounted runtime or
  frame node immediately and persist in the background.
- Computed-but-unauthored properties displayed a dash, leaving width, height,
  and zero spacing without an editable baseline. Quiet fields now display the
  computed value while authored fill and one-click removal preserve source
  provenance.
- Grid implicit tracks, independent outline/border values, extended text
  wrapping, and perspective origins were exposed in UI/export without complete
  runtime readback. The runtime property payload now covers the full inspector
  export set.
- A pinned structural raster retained the frame pixels but the exact-source
  filter removed and recreated the selection/spacing overlay, producing the
  remaining blue-line flicker. Selection DOM now follows stale-while-revalidate
  semantics and exact selected-node readback gates cover removal.
- Motion saves mixed `keyframes.set` with `node.set-styles`, so they missed the
  style-only adoption path and navigated despite changing no document
  structure. Bounded CSSOM keyframe adoption now promotes that generation on
  the existing private runtime channel.
- Theme token changes navigated every connected frame. Base and named-mode
  variables now use the same bounded runtime-generation adoption path.
- Padding markers sat on the inner content boundary rather than at the center
  of the editable padding band, and remained visible on an idle selection.
- A source revision and Foundation revision were embedded in the Motion
  timeline React key, so saving or changing an unrelated style destroyed the
  timeline and its draft.
- Motion playback published every playhead tick into `DesignCanvas`, forcing
  the entire frame/selection tree to reconcile at animation-frame frequency.
- Rapid Layers hover made the whole canvas subscribe to hovered identity rather
  than updating one small frame-local outline.
- A large unchanged runtime layer tree was rebuilt, structured-cloned, and
  flattened after ordinary padding, gap, size, or style commits.
- Switching between design workspaces destroyed all iframe, panel, scroll, and
  motion state instead of retaining a bounded inactive owner.
- Rule-backed `!important` styles could ignore an inline speculative preview;
  preview, cancellation, and commit now target the same exact CSS rule.
- A structural update replaced live subpixel-antialiased text with a PNG cover,
  then replaced that raster with a new iframe, making unchanged glyphs appear
  to blink. Structural handoff now keeps live outgoing pixels until a live
  incoming compositor surface is ready.
- The runtime announced readiness before pending web-font layout completed, so
  a newly revealed document could paint fallback glyphs and swap fonts one
  frame later. Readiness now follows the browser font-set completion contract.
- Adding typography fields grew the runtime's fixed computed-style snapshot to
  134 properties while the host validator still rejected anything above 128.
  Every valid ready event was silently discarded, leaving the cold-load cover
  over loaded text. The bounded protocol headroom is now 256, the browser's own
  limit-warning IDs are valid end-to-end, and a real generated ready payload is
  validated in the protocol suite.
- Runtime text details reused a 120-character, whitespace-collapsed layer-name
  summary. Opening the editor therefore changed leading/trailing whitespace,
  line breaks, and long copy before the first keystroke. Editable text now uses
  exact `textContent`; only the Layers/name summary is normalized.
- The host editor always froze itself to the old rendered rectangle. Intrinsic
  `auto`/`fit-content`/`max-content` labels consequently wrapped in the host
  while the transient iframe preview expanded, producing the apparent cloned
  second line. Intrinsic sizing, padding, border-box metrics, whitespace, font
  features, direction, and available-width constraints now match Chromium
  readback; browser smoke coverage compares both rectangles and their exact
  draft on every keystroke.
- A new or stale text host could inherit white application chrome on a white
  frame, and transient runtime paint suppression could leak an unusable fill
  into the next edit. New text receives explicit frame-appropriate typography;
  existing text uses resolved runtime paint with a visible selection-color
  fallback, explicit text fill, and caret color.
- Wheel events each derived from the last React viewport, so a trackpad burst
  could retain only its final delta. A ref accumulator now composes every event,
  preserves the pointer's world coordinate, and normalizes delta modes. The old
  5%–200% clamp was also replaced by the tested 1%–25,600% editor range.
- Pinch initially shared Cmd-scroll's `0.002`-per-pixel rate, but Chromium
  synthesizes pinch updates as ctrl-wheel events whose deltas are an order of
  magnitude smaller than scroll deltas, which made pinch zoom feel nearly
  inert. Pinch now inverts Chromium's `-100·ln(scale)` encoding exactly, so the
  canvas tracks the fingers one-to-one, with a per-event exponent clamp that
  keeps a physical ctrl-scrolled mouse notch at a familiar step.
- Settling the camera above the deep-zoom threshold hid the mounted viewport
  tile the moment its camera key changed, flashing compositor-magnified iframe
  pixels for the whole rerasterization round trip on every zoom step — per-step
  "re-rendering" with apparent position shifts. Stale tiles now stay painted in
  frame-local coordinates (the camera transform scales them like the previous
  map-tile level), captures are serialized latest-wins per frame, PNG encoding
  moved off the frame's main thread via `toBlob`, and the capture budget now
  covers a full Retina viewport at true 2× backing (it was silently capped to
  ~1.5× on common window sizes, so even settled tiles were softer than the
  display).
- A token-only edit removed and rebuilt the full generated stylesheet,
  invalidating unrelated keyframe rules and text style dependencies. It now
  mutates only the named CSSOM declaration and retains stylesheet/rule identity.
- Named theme rules targeted `data-theme` while runtime mode selection uses
  `data-zd-theme`; generated token scopes now follow the actual runtime
  attribute.
- Runtime readiness published the same snapshot twice when the selected theme
  was already active. Same-theme reuse and identical-reference store no-ops
  collapse that path to one subscriber notification.

### Keyboard, camera, and commit consistency across every gesture

- A held pointer gesture is modal, but only rotation, origin, and inline spacing
  had wired Escape to their own abort. On a move or a resize, Escape fell
  through to the canvas selection stack: the selection walked up to the parent —
  unmounting the overlay the drag was still painting — and the drag committed
  anyway on release. Backspace, Cmd+D, and the arrow-key resize reached the same
  held element. A running gesture now owns the keyboard in one place, ahead of
  the focus gate, so Escape aborts any gesture wherever focus sits (a drag is as
  often started from a Layers selection) and nothing else can retarget, delete,
  duplicate, or resize the element the pointer is holding. The three per-gesture
  listeners this replaces are gone.
- A trackpad pinch repaints the camera up to 80 ms before the viewport store
  learns the new zoom, so a gesture dividing pointer travel by the store's
  number tracks the pointer at the wrong rate for the rest of the drag. Frame
  move/resize and both group gestures still read the store; every gesture now
  divides by the painted zoom, as node, origin, and spacing already did.
- A second drag beginning before the first one's commit had been adopted rebased
  on the pre-commit details and silently discarded the first drag. The node
  gesture consulted the speculative value; group move and group resize did not,
  and did so for offsets but not sizes. One helper (`designGesturePixelBase`)
  now serves all three — and it takes the speculative value only where that
  value is a length a gesture can add to, since an inspector can leave `50%` or
  `calc(…)` on the same property and there only the computed value resolves it.
- The colour picker committed from its own Enter handler and then blurred — and
  blur commits too — so one keypress authored the same value twice, producing
  two source generations and leaving one undo with nothing visible to do. Enter
  now blurs and lets the single blur commit run, matching every other inspector
  field. Browser smoke counts source writes per Enter.
- The fill editor's background-position and background-repeat fields committed
  only on blur, so Enter appeared to do nothing in two of the six typed fields
  of the same popover.
- A gesture authored a runtime write per pointer sample even when the sample
  rounded to the integers the element already carried — at 8× zoom most of them
  do. Samples that author no change no longer cost a round trip and a layout
  flush to be told nothing moved.

## Deliberate next boundaries

The current editor is a strong HTML/CSS design baseline, not complete parity
with a general-purpose vector design suite. The following are separate product
increments because they require new source or protocol semantics rather than
more panel chrome:

- multiple animations per element and cross-layer sequencing;
- per-segment easing, a visual cubic-bezier editor, and source-backed spring
  semantics;
- direct motion-path control-point editing and path orientation;
- draggable grid track boundaries and named-line/area authoring;
- variable aliases, collection scopes, dependency diagnostics, and richer
  responsive mode binding;
- vector pen/boolean operations and component-variant authoring.

New work in these areas must retain exact-owner state, bounded speculative
work, single-transaction source commits, Escape restoration, low-zoom screen
geometry, and real-browser regression coverage.
