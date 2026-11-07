# Settings pages are owner-scoped; moving a control changes each owner's list

Target: principle 10 (every placement together), `zeros-workspaces` skill.

- Symptom: moving Computer use from its own Settings page into General
  would have removed it for organization owners in their local workspaces,
  because General was Local-only.
  Cause: `settings-section-availability.ts` keeps one section list for the
  Local owner and another for organizations; the move updated only the page.
  Rule: when a control moves between Settings pages, check both lists. Give
  an organization only the device rows (local placement; the cloud
  placeholder otherwise). Do not drop the control or give it Local's
  app-wide rows.
- Symptom: once organizations had a General page, their saved retired or
  unknown sections (`cloud-mcp`, `cloud-skills`) would have opened it instead
  of Agents. Rule: each owner falls back to its own first page;
  `parseSelection` takes that fallback.
- Symptom: an organization General that holds only gated rows renders empty
  while its features are closed. Rule: a page whose only content is gated
  carries the same gate in availability (`computerUseSectionOpen`), so the
  Settings rail and the command palette agree.
- Encoded: `cloud-channel-surfaces.test.ts` (saved `computer-use` opens each
  owner's General; unknown ids land on Agents for organizations) and
  `command-palette-model.test.ts` (an organization's General follows the
  gate; Local's does not).
