import { LegalLayout } from '../components/LegalLayout'
import { GITHUB_URL } from '../lib/site'

// ──────────────────────────────────────────────────────────
// TermsPage — /terms
// ──────────────────────────────────────────────────────────
//
// Deliberately short. Everything on this page restates something that
// is already true and checkable — the MIT licence in the repository
// root, the fact that agents run under the user's own provider
// accounts, and the no-warranty clause the licence already carries.
// Do not add invented obligations here; if the product ever needs real
// terms of service, they should be written by a lawyer and this file
// replaced wholesale.
// ──────────────────────────────────────────────────────────

export function TermsPage() {
  return (
    <LegalLayout title="Terms" updated="2026-07-26">
      <p>
        Zeros is a desktop app for macOS, distributed free of charge. These
        terms cover the app, this website and the hosted sign-in service at{' '}
        <code>app.zeros.build</code>.
      </p>

      <h2>Licence</h2>
      <p>
        The Zeros source is published under the MIT Licence — the full text
        ships in the{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          repository
        </a>{' '}
        and governs your use of the code. The source is public to read, fork
        and audit; the project does not accept outside pull requests.
      </p>

      <h2>Your account and your agents</h2>
      <p>
        You are responsible for your account and for anything done with it.
        Zeros drives coding agents against your own repositories using your own
        model-provider credentials, so your use of those agents is also subject
        to the terms of whichever providers you connect. Agents write to your
        working tree and run commands on your machine — review what they do
        before you ship it.
      </p>

      <h2>No warranty</h2>
      <p>
        As the MIT Licence states, the software is provided &ldquo;as is&rdquo;,
        without warranty of any kind, express or implied. We do not guarantee
        that the app, the download endpoint or the sign-in service will be
        available, correct, or free of defects, and we are not liable for any
        loss arising from their use.
      </p>

      <h2>Changes</h2>
      <p>
        We may update these terms; the date at the top of this page always
        reflects the last change. Continuing to use Zeros after a change means
        you accept the updated terms.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:hello@zeros.build">hello@zeros.build</a>.
      </p>
    </LegalLayout>
  )
}
