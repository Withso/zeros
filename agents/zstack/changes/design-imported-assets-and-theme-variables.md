# Imported Design assets and theme variables

- **Imported styles lost images and linked-CSS theme variables.** Render
  preparation skipped source-relative raster assets and scanned only HTML for
  Tailwind candidates. Test asset dependencies and canonical path restrictions,
  linked and snapshot CSS, and actual Local/cloud preview rendering
  (`style-sources.test.ts`, `style-sources-render.test.ts`,
  `verification-browser.test.ts`).
