The Local organization courier installed a recurring timer without a document
visibility gate. Serializing reads did not prevent an old settings response from
surviving an A → B → A switch, and tracking only the organization ID missed a
same-ID account generation reset.

Gate passive reads and their async tails, while keeping immediate owner/account
clearing active even when hidden. Use an observation epoch and store generation
for publication, plus write identity for late clear acknowledgements. The real
hook regression holds each boundary, counts hidden reads and timers, and covers
Personal, organization-local, sign-out, focus coalescing and retained same-owner
settings on error. The organization-sync-hidden-observation eval and bug-fix
playbook retain this lesson.

Self-review also caught a promise settling after visibility changed but before
the visibility event ran. Retiring that observation now keeps catch-up pending,
so a quick reveal does not wait for the focus guard or the next fallback. The
additional regression fails on the first fix and passes on the final source.
