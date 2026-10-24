# Recoverable Create drafts and source previews

- Symptom: restarting before workspace creation lost the document even when
  attachment source bytes survived. Cause: only destination chat drafts owned
  persistence and source retention. Rule: persist the pre-creation document by
  owner, project and placement, and register its inactive source references at
  startup. Encoded in `create-composer-drafts.test.ts` and
  `ui-smoke-create-drafts.mjs`, including a real IndexedDB reload.
- Symptom: a draft could reread a changed original after another upload
  released its source cache. Cause: preparation preferred a retained native
  File over the committed recovery bytes. Rule: a recovery id denotes immutable
  bytes; prefer its committed Blob and replace the original File reference.
  Encoded in `ui-smoke-create-drafts.mjs`. Missing-source tests must drop both
  preparation promises and the editor's recovered Blob, using a full reload.
- Symptom: late Local preparation navigated a newly selected cloud owner into
  Local. Cause: the destination owner was captured but navigation eligibility
  was not checked again after the await. Rule: create in the original owner and
  check the current visible Create scope before opening its chat. Keep the
  source draft when navigation is no longer appropriate. Encoded in the held
  Local preparation and cloud creation browser scenarios.
- Symptom: consuming a Create draft could destroy the last complete source
  while destination persistence used its text-only quota fallback. Cause: the
  synchronous persistence API did not report degraded writes. Rule: consume
  only after the complete destination snapshot persists and only at the
  submitted revision. Encoded in `persist-composer-drafts.test.ts`,
  `create-composer-drafts.test.ts` and the delayed-success browser scenario.
- Symptom: a cold cloud catalog flashed Local controls and checking text.
  Cause: backend selection depended on catalog readiness. Rule: derive the
  placement from owner identity, restore the exact account/organization's
  catalog synchronously and refresh it in the background. Encoded in
  `cloud-computer-create.test.ts`,
  `cloud-computer-repository-snapshots.test.ts` and the held-refresh browser
  scenario. A picker choice must also supersede an older route hint.
- Symptom: valid writes could be rejected wholesale after restart. Cause:
  catalog serialization exceeded its load budget, and Create accepted more
  attachment metadata than hydration allowed. Rule: test write/read budget
  parity, including aggregate catalogs and attachment counts. Evict stale
  catalogs; refuse excess unsent draft metadata without replacing saved work.
  Encoded in the two stores' regression suites.
- Symptom: switching projects reset an explicitly chosen model to the default.
  Cause: the new document key also remounted page-wide configuration state.
  Rule: keep model and permission choices with the open Create page while its
  document restores by owner/project/placement. Encoded in the project and owner
  switching scenario in `ui-smoke-create-drafts.mjs`.
- Review finding: switching projects preserved text but lost linked workspace
  pills. The directories lived outside the editor and never entered its saved
  document. Persist those references in the same scoped record, include them
  in draft presence and revision checks, and save add/remove actions before
  navigation. Keep the Local directory picker unavailable in cloud Create.
  Encoded in the draft-store regressions and the browser project/owner/reload
  sequence, including directory-only drafts and removal of the final pill.
- CI finding: removing Create's mode toggle left an engine Design contract
  requiring that retired renderer control. Trace removed identifiers across
  package boundaries and run `check:design-containment` for changes to Design
  entry points. The updated `agent-isolation.test.ts` asserts the Code-only
  Create page and public workspace Design initialization while retaining its
  native-runtime and agent-authority checks.
- Symptom: a sandboxed PDF frame stayed blank in Chromium. Cause: its built-in
  PDF plugin cannot run in that sandbox. Rule: verify the real browser renderer
  before advertising a format and keep a download fallback when no safe viewer
  exists. Encoded in `create-attachment-preview.test.ts`. Preview Markdown is
  loaded lazily and strips executable, remote-media and app-styling content;
  browser smoke covers stale reads, sanitization, focus, removal/Undo and URL
  cleanup.
