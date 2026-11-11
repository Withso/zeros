# Conductor sandbox: private settings, browser builds and smoke paths

Target: `gotchas.md` (credentials entries).

- **Private settings print credentials.** `.conductor/settings.local.toml`
  embeds base64 workspace environment variables, including hosted profiles and
  the agent GitHub App key. Never `cat` or `head` `.conductor/*` wholesale to
  find the setup script; read `.conductor/settings.toml`, or one key of the
  local file with a filter that prints no values.
- **Browser build missing.** In a Conductor cloud workspace (Vercel sandbox),
  Chromium-backed Design renderer suites fail to launch with
  `Executable doesn't exist at …/chromium_headless_shell-1217/…`.
  `pnpm exec playwright install chromium` works there and fixes them; record
  the missing browser in the receipt rather than calling the suites flaky.
- **Shell umask.** The sandbox shell starts with `umask 0002`, so the
  `scripts/__tests__` dev-environment, dev-auth and zstack-replay suites fail
  with "Unsafe … directory" on group-writable fixtures. Run `pnpm test:git`
  under `umask 022`, as CI does, before treating them as regressions.
- **Never edit while a full suite runs.** A red-check edit made mid-run lands
  in that run's results; prove a regression red only between suite runs.
