# A harness that fakes an engine operation mirrors its semantics

**Symptom.** Renaming a theme variable in the Design harness added the new
name but kept the old row, and Delete removed nothing, while the real
`token.set` adapter removes a declaration whose value is null.

**Cause.** The harness's `token.set` fake blanked the `:root` value instead of
removing it, and kept listing a variable nothing declared. The feature looked
broken; the fake was.

**Rule.** When a harness answers an engine operation itself, mirror the
adapter's semantics, deletes included, and say so beside the fake. When a
harness disagrees with the product, read the fake before changing the
feature, and pin the operation's real effect in a unit test through the real
adapter or mutation helper.

**Encoded in.** The `token.set` fake in
`harnesses/harness-design-workspace.tsx`, and
`features/design-workspace/__tests__/design-theme-css.test.ts`, which applies
rename and delete operations through `mutateDesignTokenDeclaration`. Target:
`agents/zstack/gotchas.md`.
