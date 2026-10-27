# Turn footer deletion color

- Symptom: aggregate deletion counts, including `−0`, appeared blue while
  file-row deletions appeared red. Cause: the footer, its presentation guide
  and its checks agreed on blue despite the design system's red `−N` contract.
- Rule: use the same green additions and red deletions across diff summaries
  and file rows, including zero counts. Check the rendered deletion's computed
  color against the semantic token in both themes, independently of its class.
- Encoded in the existing footer markup checks, turn-changes browser smoke,
  the output-footer contract and the `turn-footer-deletion-color` eval case.
