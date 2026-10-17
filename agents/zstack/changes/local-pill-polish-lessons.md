# Test UI metadata in its real ancestor, against its real surface

- Symptom: "Sent from" looked right in an isolated renderer but sat inside the
  bubble in the app. Cause: `TurnPromptHeader`, not `TextMessage`, owns the
  bubble chrome. Rule: assert metadata in its actual ancestor layout, including
  narrow panes, steered and saved messages.
- Symptom: a light-theme workspace pill vanished on the composer though its
  label contrast passed. Cause: only text-on-fill was checked; the composer
  surface is `bg2`. Rule: compare a fill with the real adjacent surface and pin
  the other theme's values explicitly.
- Symptom: a broad error-colour rule recoloured identity pills, and a Local CLI
  error row used a different red and font. Rule: failed rows share one preview
  recipe; embedded identities keep their own look; compare computed styles.
- Symptom: shell recognition rejected a harmless stdin heredoc, while display
  unwrapping could hide a newline command boundary. Rule: recognise operations
  on command boundaries independently of display formatting; accept only one
  literal heredoc and never evaluate its body.

Encoded in `renderer/features/agent/__tests__/local-links.test.ts`,
`local-pill-theme.test.ts`, `local-cli-presentation.test.ts` and
`scripts/ui-smoke-local-links.mjs`.
