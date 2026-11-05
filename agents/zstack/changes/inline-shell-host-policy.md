# A shared inline-styled page needs the policy it is served under to allow it

**Symptom.** Moving the Ops sign-in pages onto the web's centred shell would
have shipped them unstyled: the shell's stylesheet is inline, and the Ops host
sends `style-src 'self'`. The control plane's sign-in and GitHub pages, served
through the app and Ops hosts, carried `default-src 'none'` with no style
source at all.

**Cause.** `applyHostHeaders` keeps a policy a route sets and fills in the
host's policy otherwise, so each page is governed by its own header or its
host's, and they differ: the app allows inline style, Ops does not, and the
control plane's pages set their own.

**Rule.** Before a page moves onto a shared shell, read the policy it is served
under: its own header first, else its host's. Allow the shell's one inline
stylesheet by its CSP hash, never by widening to `'unsafe-inline'`, and pin the
hash with a test that hashes the rendered style.

**Encoded in.** `HOSTED_PAGE_STYLE_SOURCE` and its hash test in
`apps/control-plane/src/hosted-page.test.ts`, the Ops note in plans.md §8, and
eval case `inline-shell-host-policy`, fixed by commit 5b903826.
