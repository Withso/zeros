# Desktop content selection

- Symptom: dragging across the desktop window, or using Select All, highlighted
  sidebar navigation, tabs and review controls alongside conversation text.
- Cause: selection was disabled piecemeal on controls; document defaults still
  treated the desktop as a web article. Buttons composed as links also inherited
  selection from readable content. A blanket reset alone would break thinking,
  tool results, queued prompts, questions and read-only/vendor code views.
- Rule: default desktop chrome to non-selectable, opt readable content and
  editors back in at their owning boundaries, and preserve explicit drags.
  Verify actual mouse selection and Select All, including portals, composed
  controls, Local/cloud switching and both themes. DOM Range assignment alone
  cannot prove that a person can select text.
- Encoded in: `styles/global/document.css`, content/primitive/vendor opt-ins,
  `docs/design-system.md`, `playbooks/ui-design.md` and the real-browser
  `scripts/ui-smoke-text-selection.mjs` regression in UI smoke shard 1.
