# Playbook: UI and design

For renderer UI, styling, tokens and mockups of Zeros itself. The `zeros-ui`
skill holds the design-system rules; this playbook is the procedure around
them.

1. **Frame the change.** Read `docs/design-system.md` §0 (the direction) and
   the page's `docs/design-implementation/<page>.md`, if any. Name the
   surface and its owning component, and list the states it must show:
   default, hover, selected, focus-visible, disabled, loading, empty, error,
   and long or missing content. Cover Dark and Light, and how Local and cloud
   workspaces differ, including each cloud VM state (RULES.md §8).
2. **Design first when the look changes.** Mock it in `Zeros - Design/` (the
   Design tab) and follow its `rules.md`. Frames import the app's own
   stylesheets live as style sources and link `../tokens.css` for Design-only
   tokens. Never hand-copy token values into a standalone HTML file; a product
   token change goes to `styles/tokens/*.tokens.json`, which the Design tab
   previews before `pnpm design:docs` regenerates the CSS.
3. **Verify the frame, then get approval.** Run `design validate` and
   `design capture` from the frame context and inspect the PNG yourself.
   Capture both themes: the default is Dark, and `--theme light` captures
   Light the way the canvas Themes menu shows it. `design styles` confirms the
   imported sources are ready. The native URL expires after 30 minutes; the
   Design API's `design_lint` and `design_capture` (with `theme`, at the
   frame's own size) verify the same revision without it. Existing visual
   behavior is a contract (RULES.md §3), so implement a visual change only
   after the user approves the frame.
4. **Red.** A bug needs a failing test or ui-smoke assertion first; a behavior
   change needs a concrete usage example.
   For focus bugs, exercise real pointer → ordinary key → Tab sequences and
   include descendant selectors and shadow-root controls. Hold deferred work,
   move focus, then release it; also verify the uninterrupted handoff so a
   focus guard cannot pass merely by disabling restoration.
5. **Implement with the system.** Compose the shared primitives and layout
   blocks, and map frame values to utilities (`var(--bg2)` is `bg-bg2`; a
   `--space-<step>` value is that Tailwind step) instead of copying frame
   CSS. Extend a primitive, with a test; never restyle it from a caller. Fix
   drift in the files you touch and list the rest in the receipt. Where an
   approved board breaks a system rule, keep the rule and log the decision.
   Lists, selection, navigation, tabs, panels and loading follow
   `docs/ui-interaction-performance.md`.
6. **Gates** (`zstack-verify`). Never get `pnpm check:ui` green by raising
   `styles/policy/ui-debt.json` or adding an ignore; prune paid debt with
   `pnpm check:ui --prune-debt`. Overlay, focus, popover or composer work runs
   `pnpm test:ui-smoke` (label `ci:ui-smoke`); cascade, entrypoint or
   performance work runs `pnpm build:ui`; token or contrast changes run
   `pnpm design:docs`. A primitive change (a shared class constant is one)
   tests every call shape (asChild, loading, inside a Tooltip), sizes each
   importer by its context, recomputes offsets made for an old size, moves
   the overlays that fade from a fill it changes, and
   updates in the same commit every smoke that pins it, found by its
   `data-slot` names and old values. A component named by a prop declares
   `aria-label?: never`; a glyph standing for a word keeps it as name and
   hover title; focus edges take no layout space. Run the registry shards for
   a page step's surfaces before committing it; compare geometry with a
   tolerance.
7. **Look at the result** in the running app or a ui-smoke harness, in both
   themes; a green check is not visual review. Put screenshot paths in the
   receipt.
   Selection changes need real pointer drags and Select All: programmatic
   Range selections bypass CSS. Cover portalled chrome, composed link buttons,
   chat/question/queue content, read-only editors, shadow-DOM diffs and explicit
   drag-and-drop, including Local and cloud owner switches.
8. **Deliver and learn** (`integrate-pr.md`, `zstack-learn`). State the Local
   and cloud impact. A look the user corrects or approves is a direction
   (design-system.md §0, "How the direction changes"): move its owner and
   migrate callers, add the check that holds it, record it in §0 and the page
   spec, run `pnpm design:docs`, and retire what it replaces; two directions
   never coexist. An escaped mistake gets an eval case. Close a shipped round
   on the canvas: every board shows the UI as it ships, a logged decision
   updates its board, and an approved design not built yet keeps a Planned
   line naming its `plans.md` section.
