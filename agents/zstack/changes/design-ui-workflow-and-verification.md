# Design UI workflow

- **UI work had no procedure, and mockups drifted from the product.** 20 of 25 standalone mockups in
  `styles/Artifacts/` hand-copied token values that later changed, so designs no longer matched the app.
  Zeros mockups now live in `Zeros - Design/`, whose `tokens.css` `pnpm design:docs` generates and
  `check:ui` keeps fresh. UI work follows design → verify → approve → implement → look
  (`playbooks/ui-design.md`, `zeros-ui`).
