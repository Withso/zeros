Building a large page of captured app frames lost Light verification as soon
as the 30-minute native verification URL expired: the Design API capture had
no theme and required width/height ≤ 2048, so it showed only Dark and cropped
any frame larger than one raster. The API capture now mirrors
`zeros-engine design capture`: an optional `theme` validated against the
directory's themes, the frame's own size by default, and scaling into one
2048 raster (`code-tools.test.ts`, `theme-rendering.test.ts`). The UI playbook
names the API as the fallback verifier.

The same work misread the skill's "16 MiB total" as a directory budget and
raised it with the user; the cap is per frame document
(`packages/design-web/src/model.ts`). The skill and roadmap now say so. Read
the enforcing constant before reporting a limit as a constraint.

Lint warned `unknown-token` on `var(--zeros-fi, var(--zeros-fi-blue))`, an
intentionally undeclared hook in the app's file icons, and advised declaring
it, which would recolour every icon. A var() with a fallback is optional and
no longer warns (`document.test.ts`).
