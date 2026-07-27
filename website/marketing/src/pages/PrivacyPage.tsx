import { LegalLayout } from '../components/LegalLayout'
import { GITHUB_URL } from '../lib/site'

// ──────────────────────────────────────────────────────────
// PrivacyPage — /privacy
// ──────────────────────────────────────────────────────────
//
// Every claim here is checkable against the published source, which is
// the point: the app is source-available, so a vague or flattering
// privacy page is a page someone can disprove in an afternoon. Keep it
// that way. If you change what the app sends, change this page in the
// same PR. The load-bearing sources are:
//
//   • src/zeros/analytics/posthog.ts   — autocapture/session recording
//                                        off, identify() never called
//   • src/zeros/analytics/consent.ts   — opt-OUT model, Settings → Privacy
//   • src/zeros/feedback/submit-feedback.ts — what the feedback form sends
//   • electron/updater.ts              — the GitHub Releases update feeds
//   • website/web-app/lib/hub.ts       — the Auth0 sign-in handoff
// ──────────────────────────────────────────────────────────

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy" updated="2026-07-26">
      <p>
        Zeros is a local-first Mac app. Agents run on your machine, against
        your checkout, using your own model credentials. This page describes
        every case where something leaves your Mac.
      </p>

      <h2>What we never receive</h2>
      <p>
        Your source code, your prompts, your agents&apos; conversations, your
        terminal output and your API keys are not sent to Zeros. They stay on
        your machine, in your repository and in the app&apos;s local storage.
      </p>
      <p>
        Zeros does not proxy your model traffic. When you run Claude Code,
        Codex or Cursor inside Zeros, those agents talk to their own providers
        directly under your own account, and that traffic is governed by those
        providers&apos; privacy policies — not this one.
      </p>

      <h2>Sign-in</h2>
      <p>
        Signing in opens a browser handoff through{' '}
        <code>app.zeros.build</code>, which uses Auth0 as the identity
        provider. We receive the email address and the provider identity
        (Google or GitHub) that Auth0 returns, and store them so the app knows
        who you are across restarts.
      </p>

      <h2>Product analytics</h2>
      <p>
        The app sends anonymous, metadata-only product analytics to PostHog.
        This is <strong>on by default</strong>. You can turn it off at any time
        in <strong>Settings → Profile → Usage data</strong>, and nothing is sent after you
        do.
      </p>
      <ul>
        <li>
          Events are explicit and metadata-only — things like &ldquo;a
          workspace was created&rdquo; or &ldquo;an agent run finished&rdquo;,
          plus app version, platform and architecture.
        </li>
        <li>
          Autocapture is disabled, so no DOM text, clicks, file paths or chat
          content are ever collected automatically.
        </li>
        <li>Session recording is disabled — your screen is never recorded.</li>
        <li>
          We never call PostHog&apos;s <code>identify()</code>, so events carry
          no person profile and are not linked to your account. The one
          exception is feedback: if you choose to send a report, the anonymous
          analytics id is attached to it so we can find the related events.
          See &ldquo;Feedback you send us&rdquo; below.
        </li>
      </ul>

      <h2>Error reports</h2>
      <p>
        Unhandled errors are reported to the same PostHog project as scrubbed
        exceptions: the message and stack are run through a secret scrubber
        first. Error reporting follows the same opt-out switch as analytics.
      </p>

      <h2>Update checks</h2>
      <p>
        The app periodically fetches release metadata from{' '}
        <code>github.com</code>, where its releases are published. Like any HTTP
        request, that reveals your IP address to GitHub and the app version
        asking. We receive no report of these checks.
      </p>

      <h2>Feedback you send us</h2>
      <p>
        Nothing is sent from <strong>Help → Feedback</strong> unless you submit
        the form. When you do, we receive your message, the feedback type, the
        area of the app it came from, the app version, your anonymous analytics
        id, the verified email address on your signed-in account so we can
        reply, and — only if you tick &ldquo;Include recent app logs&rdquo; — a
        secret-scrubbed tail of the app log, which you can read in full before
        sending. It is handled by our support tooling so we can respond and
        track the issue.
      </p>

      <h2>Verifying this</h2>
      <p>
        The client is published at{' '}
        <a href={GITHUB_URL} target="_blank" rel="noreferrer">
          github.com/withso/zeros
        </a>
        . If you find a discrepancy between this page and the code, the code is
        the truth and we want to hear about it.
      </p>

      <h2>Contact</h2>
      <p>
        Questions, or a request to delete your account data:{' '}
        <a href="mailto:hello@zeros.build">hello@zeros.build</a>.
      </p>
    </LegalLayout>
  )
}
