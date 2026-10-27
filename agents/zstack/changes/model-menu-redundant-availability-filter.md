# Model availability belongs to each row

Symptom: both the model picker and its catalog submenu showed a redundant
"Show available models" action while eligible models were already selectable.

Cause: account-model recovery added an availability filter to both surfaces,
and its browser regression required clicking that filter before picking an
alternative. That preserved an unnecessary step in the picker.

Rule: retain unavailable model identities, disabled rows and their reasons;
make eligible alternatives directly selectable in the existing catalog and
search. Verify the main picker, submenu and search after reopening, including
when the selected model is eligible and another model is unavailable.

Encoded in `scripts/ui-smoke-shared-default-model.mjs`, across Local Personal,
organization-local and cloud placements in both themes, and
`docs/agent-tool-presentation.md`.
