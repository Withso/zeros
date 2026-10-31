# Widening what counts as a design node, and scoped replies

Target: `playbooks/feature.md` (verify step) and `gotchas.md` (Design).

- **Symptom.** Making declarative shadow content into design nodes made
  identities, Layers and inspection correct, but six producers still assumed
  light DOM. Duplicate copied shadow identities verbatim (the document became
  invalid), component lint failed saves, asset inserts and Text tool commits
  picked shadow parents and were refused, and slotted children vanished from
  the engine frame tree.
- **Rule.** When a change widens the node model, list every producer and
  consumer of that model: heal, projection, walkers, duplicate, move, insert,
  lint and hit testing. Give each one a regression test against the new shape
  before claiming parity. Follow the HTML parser's rules (valid host, first
  template, open mode, slot assignment) rather than "any template".
- **Scoped acknowledgements.** A scoped reply carries no lint and prepares
  only the frames it names. The renderer projection must keep other files'
  rows. A write that reaches a stylesheet, tokens.css or a component must read
  the aggregate. Geometry reports `design.toml` in `affectedFiles`, which is
  not a shared source.

Encoded in: design-web `shadow-content.test.ts`; engine
`shadow-content-identities.test.ts` and `document.test.ts`; runtime
`design-runtime-shadow.test.ts`; `design-workspace-preparation.test.ts`;
`design-page-history-scoped.test.ts`; and the service test "returns the
aggregate for Undo and Redo of a token change".
