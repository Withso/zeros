# Playbook: UI and design

For renderer UI, styling, tokens and mockups of Zeros itself. The `zeros-ui`
skill holds the design-system rules; this playbook is the procedure around
them.

1. **Frame the change.** Name the surface and its owning component, and list
   the states it must show: default, hover, selected, focus-visible, disabled,
   loading, empty, error, and long or missing content. Cover Dark and Light,
   and how Local and cloud workspaces differ, including each cloud VM state
   (RULES.md §8).
2. **Design first when the look changes.** Mock it in `Zeros - Design/` (the
   Design tab) and follow its `rules.md`. Frames link `../tokens.css`, which
   `pnpm design:docs` generates from `styles/tokens/`. Never hand-copy token
   values into a standalone HTML file; a product token change goes to
   `styles/tokens/*.tokens.json`.
3. **Verify the frame, then get approval.** Run `design validate` and
   `design capture` from the frame context and inspect the PNG yourself.
   Capture both themes: the default is Base (Dark), and `--theme light`
   captures Light the way the canvas Themes menu shows it. Existing visual behavior is a
   contract (RULES.md §3), so implement a visual change only after the user
   approves the frame.
4. **Red.** A bug needs a failing test or ui-smoke assertion first; a behavior
   change needs a concrete usage example.
5. **Implement with the system.** Compose the shared primitives and layout
   blocks, and map frame values to utilities (`var(--bg2)` is `bg-bg2`; a
   `--space-<step>` value is that Tailwind step) instead of copying frame
   CSS. Lists, selection, navigation, tabs, panels and loading follow
   `docs/ui-interaction-performance.md`.
6. **Gates** (`zstack-verify`). Never get `pnpm check:ui` green by raising
   `styles/policy/ui-debt.json` or adding an ignore; prune paid debt with
   `pnpm check:ui --prune-debt`. Overlay, focus, popover or composer work runs
   `pnpm test:ui-smoke` (label `ci:ui-smoke`); cascade, entrypoint or
   performance work runs `pnpm build:ui`; token or contrast changes run
   `pnpm design:docs`.
7. **Look at the result** in the running app or a ui-smoke harness, in both
   themes; a green check is not visual review. Put screenshot paths in the
   receipt.
8. **Deliver and learn** (`integrate-pr.md`, `zstack-learn`). State the Local
   and cloud impact. When a mockup, token or check drifted, encode the lesson.
