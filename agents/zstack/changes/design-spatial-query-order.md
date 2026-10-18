# Spatial distance and stable identity ties

- **Symptom.** Accepted tiny rectangles could choose a farther center, and
  collating-equal distinct names could select a different top-N membership from
  the stable brute-force result.
- **Cause.** Squared distances underflowed to zero, including in the original
  test oracle. Locale collation alone was not a total candidate order, so tree
  traversal decided otherwise equal candidates.
- **Rule.** Use one underflow-safe metric for both candidates and pruning bounds.
  Preserve original ordinals after equal distance and equal locale collation.
  Test numeric ordering against a separately scaled Euclidean oracle rather
  than repeating the implementation's arithmetic.
- **Encoded in.** `design-frame-spatial-index.test.ts` retains both independent
  review counterexamples, positive-subnormal coverage and multi-scale nearest
  and constrained-nearest comparisons. These failed on the unmerged helper
  head; they are not claimed as historical-mainline catches.
