# Web app: board-by-board design spec

<!-- GENERATED from the Zeros Design canvas by the design implementation spec generator. Do not edit by hand; status and decisions live in README.md. -->

Source: the Zeros Design canvas, page “Web app”, version `1793762476-d72a`. Each board below is one frame. “Change” lines are the approved design the implementation must match; “Code notes” record how today's code behaves and where. Composite boards (All states) restate other boards and carry no changes of their own.

## Web app — every page and state (`WebMap`)

Owner today: `apps/webapps/control-plane59 frames · 10 groups`

No change beyond the shared foundation and primitives.

## Sign in to Zeros · WorkOS · / (`WebSignIn`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- One sign-in page for WorkOS and the Auth0 rollback: Continue with Google and Continue with GitHub, both primary with their logos, 260px wide. No extra Continue.
- Buttons never underline; the description runs on one line up to 560px and wraps only when it is longer.
- Tokens replace the hard-coded #0c0c0d page and #a1a1aa text, so Light works too.

Code notes:
- One sign-in page for both routes. WorkOS renders a lone Continue and the Auth0 rollback renders Google and GitHub; both should render Continue with Google and Continue with GitHub. (`apps/web/lib/workos-browser.mjs:146-157`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Sign in to Zeros · Auth0 rollback · / (`WebSignInRollback`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- One sign-in page for WorkOS and the Auth0 rollback: Continue with Google and Continue with GitHub, both primary with their logos, 260px wide. No extra Continue.
- Buttons never underline; the description runs on one line up to 560px and wraps only when it is longer.

Code notes:
- One sign-in page for both routes. WorkOS renders a lone Continue and the Auth0 rollback renders Google and GitHub; both should render Continue with Google and Continue with GitHub. (`apps/web/lib/workos-browser.mjs:146-157`)
- Two stacked primary buttons (Google and GitHub). (`apps/web/lib/hub.ts:104 · apps/web/lib/workos-browser.mjs:148-157`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)

## Completing sign in · WorkOS · /auth/callback (`WebSignInCompleting`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The browser-default 28px bold heading and underlined link become the shared title and a primary action.

Code notes:
- A browser-default 28px bold h1 in a 28rem container with an underlined link, and no logo. (`apps/control-plane/src/workos-browser-sessions.ts:1055-1067`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Sign-in didn't finish · Auth0 · /auth/callback (`WebSignInFailed`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Each reason is one line under 70 characters; Nothing was changed is said once.
- Unverified email no longer says try again right after verify first.

Code notes:
- Copy drifts: Delete organization reads differently on server and client; recovery without a code still mentions the code; unverified email says verify first, then just try again. (`apps/web/lib/dashboard.mjs:248,363 · apps/web/public/dashboard.js:518 · apps/web/functions/auth/callback.ts:24,63`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Sign-in didn't finish · WorkOS plain text · /auth/callback (`WebSignInFailedText`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The text/plain error becomes the shared page with a title, one reason and Try again.

Code notes:
- WorkOS failures come back as text/plain, up to 140 characters, with no Try again. (`apps/web/lib/workos-browser.mjs:61-72 · apps/control-plane/src/workos-browser-sessions.ts:994-1016`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## You're signed in · /launch (`WebSignedIn`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Open Zeros is the main action; Go to web (with arrow-up-right) opens the dashboard, since you’re signed in.
- Sign out moves into a quiet 12px line with the account.
- Buttons never underline; the description runs on one line up to 560px and wraps only when it is longer.

Code notes:
- Wrong or missing main action: a 13px Sign out link only, Get Zeros on an incomplete invite, Refresh beside a raw status. (`apps/web/lib/hub.ts:120,206,240 · apps/web/lib/invite-page.mjs:93 · apps/web/lib/workspace-page.mjs:70-72`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Launch Zeros · legacy desktop handoff · /?scheme= (`WebLaunch`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The title reads Go to Zeros, so this page no longer shares You’re signed in with the signed-in page.
- Signed in, so Go to web (with arrow-up-right) sits beside Launch Zeros and opens the dashboard.
- Status sits 12px under the actions in 12px text; errors use red-fg.

Code notes:
- Wrong or missing main action: a 13px Sign out link only, Get Zeros on an incomplete invite, Refresh beside a raw status. (`apps/web/lib/hub.ts:120,206,240 · apps/web/lib/invite-page.mjs:93 · apps/web/lib/workspace-page.mjs:70-72`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Opening Zeros… · /auth/desktop/callback (`WebDesktopOpening`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 81-character line becomes one sentence under 70.
- No close-this-tab line: one sentence and one action.

Code notes:
- Drop the close-this-tab line. The desktop callback adds “You may close this tab after the app opens.” under the action. (`apps/web/lib/workos-desktop-authorization.mjs:152`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Sign-in wasn't completed · /auth/desktop/callback (`WebDesktopNotCompleted`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The close-this-tab line only shows after a successful handoff, so it no longer contradicts this page.

Code notes:
- Status contradicts the page: Checking… stays forever without JavaScript, and the failed page still says you may close this tab after the app opens. (`apps/web/functions/github/connected.ts:66,69 · apps/web/lib/workos-desktop-authorization.mjs:152`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Sign-in didn't finish · /auth/desktop (`WebDesktopInvalid`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- No more dead end: Open Zeros (or Try again) is always offered.

Code notes:
- Dead end: the page offers no action. (`apps/web/lib/workos-desktop-authorization.mjs:59-69 · apps/web/functions/github/connected.ts:36-38 · apps/web/lib/ops.ts:196`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Finish GitHub connection · checking · /github/connected (`WebGitHubChecking`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 56px hero logo, 32px title and 16px line come down to the shared scale; a 16px loader replaces the hidden button.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## GitHub connected · /github/connected (`WebGitHubConnected`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Open Zeros is a 28px primary, not a 48px full-width hero button.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## GitHub connection canceled · /github/connected (`WebGitHubCanceled`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Canceled and failed get their own line instead of sharing one 66-character sentence.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## GitHub couldn’t connect · /github/connected (`WebGitHubFailed`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Canceled and failed get their own line instead of sharing one 66-character sentence.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## This GitHub link is incomplete · /github/connected (`WebGitHubIncomplete`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- No more dead end: Open Zeros sits under the line.

Code notes:
- Dead end: the page offers no action. (`apps/web/lib/workos-desktop-authorization.mjs:59-69 · apps/web/functions/github/connected.ts:36-38 · apps/web/lib/ops.ts:196`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## This GitHub handoff has expired · after 60 seconds (`WebGitHubExpired`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The button stays instead of disappearing after 60 seconds.

Code notes:
- Dead end: the page offers no action. (`apps/web/lib/workos-desktop-authorization.mjs:59-69 · apps/web/functions/github/connected.ts:36-38 · apps/web/lib/ops.ts:196`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## JavaScript turned off · /github/connected (`WebGitHubNoScript`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The noscript sentence replaces the Checking… line instead of sitting under it forever.

Code notes:
- Status contradicts the page: Checking… stays forever without JavaScript, and the failed page still says you may close this tab after the app opens. (`apps/web/functions/github/connected.ts:66,69 · apps/web/lib/workos-desktop-authorization.mjs:152`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## GitHub connected · cloud workspace · control plane (`WebGitHubCloud`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The unstyled serif-on-white control-plane page uses the shared shell.

Code notes:
- Bare HTML with no viewport meta or color-scheme: the default serif on white. (`apps/control-plane/src/github.ts:990`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## You've been invited to Zeros · /invite (`WebInvite`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- One primary and two quiet ghost actions replace three full-width stacked buttons.

Code notes:
- Three full-width stacked buttons plus a hint link. (`apps/web/lib/invite-page.mjs:113-117`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Accept your invitation · /invite?mode=web (`WebInviteAccept`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Accept invitation is the primary, and the status line only carries status.

Code notes:
- The only action, Accept invitation, is styled secondary, under a status line that repeats the subtitle. (`apps/web/lib/invite-page.mjs:246-248`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Accept your invitation · different account (`WebInviteWrongAccount`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 93-character red paragraph becomes the description; the only action is the primary.

Code notes:
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## This invite link is incomplete · /invite (`WebInviteIncomplete`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Get Zeros moves into the quiet download line, since it doesn’t fix the link.

Code notes:
- Wrong or missing main action: a 13px Sign out link only, Get Zeros on an incomplete invite, Refresh beside a raw status. (`apps/web/lib/hub.ts:120,206,240 · apps/web/lib/invite-page.mjs:93 · apps/web/lib/workspace-page.mjs:70-72`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Cloud workspace · loading · /workspace/{id} (`WebWorkspaceLoading`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- A 16px loader replaces the disabled Refresh.

Code notes:
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Cloud workspace · access confirmed (`WebWorkspaceReady`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The workspace name is the title; Open in Zeros is the main action and Refresh a ghost.
- The raw Status: [status] line goes away.

Code notes:
- Wrong or missing main action: a 13px Sign out link only, Get Zeros on an incomplete invite, Refresh beside a raw status. (`apps/web/lib/hub.ts:120,206,240 · apps/web/lib/invite-page.mjs:93 · apps/web/lib/workspace-page.mjs:70-72`)
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Cloud workspace · unavailable (`WebWorkspaceUnavailable`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- A title that names the problem; one line per reason.

Code notes:
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Join a cloud workspace · /workspace/{id}/invite (`WebWorkspaceInvite`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Disabled states dim the primary instead of swapping in a second button.

Code notes:
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Join a cloud workspace · unavailable (`WebWorkspaceInviteUnavailable`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 139-character message becomes one line; Accept invitation is dropped while it can’t work.

Code notes:
- No logo: only the GitHub pages show one, so every other centered page starts with text. (`apps/web/lib/page.ts:42-46 · apps/web/lib/hub.ts:107 · apps/web/lib/invite-page.mjs:111`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Profile · Personal · /?section=profile (`WebProfile`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- Delete account is a destructive-secondary button in a normal group, not a red danger card.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)

## Profile · recoverable organizations (`WebProfileRecoverable`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- Recoverable organizations are rows with Restore, inside the group recipe (no padding-0 card).

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- Padding nests wrong: the Recoverable title touches the card edge while rows sit 20px in; the recovery-code row is inset 40px with a hairline that stops 20px short. (`apps/web/public/dashboard.js:494 · apps/web/lib/dashboard.mjs:247-249`)
- At 760px and below .card { padding: 16px } beats .settings-card { padding: 0 }: rows get a 36px inset and hairlines stop 16px short. (`apps/web/public/dashboard.css:176,317-321`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)

## General · Personal · /?section=general (`WebGeneralPersonal`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- With no cloud organization yet, the switcher row and the page offer Create organization; Members, Teams and Billing wait for one.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- At 760px and below .card { padding: 16px } beats .settings-card { padding: 0 }: rows get a 36px inset and hairlines stop 16px short. (`apps/web/public/dashboard.css:176,317-321`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)

## General · organization owner (`WebGeneralOwner`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- No Workspaces group: Local workspaces belong to Local, and cloud organizations run cloud workspaces only, so the capability rows go.
- The name field is a 200px input with Save beside it, so it never clips.
- Roles are capitalized badges; copy is a 24px icon button with a lucide glyph.

Code notes:
- Remove Workspace access from General. Local workspaces belong to Local, which the web no longer shows; cloud organizations run cloud workspaces only, so the capability card has nothing to say. (`apps/web/lib/dashboard.mjs:355,362`)
- Between 761 and ~1080px wide the name row clips Save: the control is min(430px, 46vw) in a minmax(0, auto) column with overflow hidden. (`apps/web/public/dashboard.css:176,180,192`)
- Copy drifts: Delete organization reads differently on server and client; recovery without a code still mentions the code; unverified email says verify first, then just try again. (`apps/web/lib/dashboard.mjs:248,363 · apps/web/public/dashboard.js:518 · apps/web/functions/auth/callback.ts:24,63`)
- Role badges are lowercase (owner) while selects are capitalized, and invite and deletion dates use two formats. (`apps/web/lib/dashboard.mjs:360 · apps/web/public/dashboard.js:9-18,515,546-547,563`)
- At 760px and below .card { padding: 16px } beats .settings-card { padding: 0 }: rows get a 36px inset and hairlines stop 16px short. (`apps/web/public/dashboard.css:176,317-321`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)

## General · organization member (`WebGeneralMember`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- No Workspaces group: Local workspaces belong to Local, and cloud organizations run cloud workspaces only, so the capability rows go.
- Read-only values are 13px fg2 text in the control slot.

Code notes:
- Remove Workspace access from General. Local workspaces belong to Local, which the web no longer shows; cloud organizations run cloud workspaces only, so the capability card has nothing to say. (`apps/web/lib/dashboard.mjs:355,362`)
- Role badges are lowercase (owner) while selects are capitalized, and invite and deletion dates use two formats. (`apps/web/lib/dashboard.mjs:360 · apps/web/public/dashboard.js:9-18,515,546-547,563`)
- At 760px and below .card { padding: 16px } beats .settings-card { padding: 0 }: rows get a 36px inset and hairlines stop 16px short. (`apps/web/public/dashboard.css:176,317-321`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)

## Members · owner or admin · /?section=members (`WebMembersAdmin`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Invite is one 28px row: email, a 128px role select and Send invite, 8px apart.
- Member rows are 52px with 28px avatars, 24px role selects and a ⋯ menu.

Code notes:
- The invite row mixes a 34px input and select with a 32px button, so Send invite sits 2px short. (`apps/web/public/dashboard.css:233,254,263`)
- Remove and Leave use window.confirm and show no success toast, while deleting an org uses a styled dialog. (`apps/web/public/dashboard.js:1036-1067`)
- Rows are at least 58px with a 34px column for a 28px avatar and 10px initials; selects and × are 30px, badges 22px. (`apps/web/public/dashboard.css:75-85,228,249,265,272`)
- Role badges are lowercase (owner) while selects are capitalized, and invite and deletion dates use two formats. (`apps/web/lib/dashboard.mjs:360 · apps/web/public/dashboard.js:9-18,515,546-547,563`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)

## Members · member (`WebMembersMember`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Non-admins get one line in the description instead of the invite card.

Code notes:
- Non-admins still see the Invite member card, with a nested notice placed by an inline margin-top: 18px. (`apps/web/public/dashboard.js:567`)
- Remove and Leave use window.confirm and show no success toast, while deleting an org uses a styled dialog. (`apps/web/public/dashboard.js:1036-1067`)
- Rows are at least 58px with a 34px column for a 28px avatar and 10px initials; selects and × are 30px, badges 22px. (`apps/web/public/dashboard.css:75-85,228,249,265,272`)
- Role badges are lowercase (owner) while selects are capitalized, and invite and deletion dates use two formats. (`apps/web/lib/dashboard.mjs:360 · apps/web/public/dashboard.js:9-18,515,546-547,563`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)

## Teams · /?section=teams (`WebTeams`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- The disabled New team button and the 111-character notice become the group description.
- The team avatar uses its initials and a neutral badge.

Code notes:
- Billing can say 1 seats and 1 organization members; every team avatar is a hard-coded D, and team roles use the green success badge. (`apps/web/public/dashboard.js:577,590`)
- Permanent placeholders: disabled buttons plus 111- and 138-character coming-soon notices; the mac app forbids coming-soon panels. (`apps/web/public/dashboard.js:580-581,591`)
- Rows are at least 58px with a 34px column for a 28px avatar and 10px initials; selects and × are 30px, badges 22px. (`apps/web/public/dashboard.css:75-85,228,249,265,272`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)

## Billing · /?section=billing (`WebBilling`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- The disabled Manage billing and the 138-character notice become the group description.

Code notes:
- Billing can say 1 seats and 1 organization members; every team avatar is a hard-coded D, and team roles use the green success badge. (`apps/web/public/dashboard.js:577,590`)
- Permanent placeholders: disabled buttons plus 111- and 138-character coming-soon notices; the mac app forbids coming-soon panels. (`apps/web/public/dashboard.js:580-581,591`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)

## Section loading (`WebSectionLoading`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- The real description shows from the first paint; skeleton rows sit at their final height.

Code notes:
- The description changes twice while loading, and the body is a padded card that only says Loading…. (`apps/web/lib/dashboard.mjs:389 · apps/web/public/dashboard.js:522-525,639`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)
- The heading block has min-height 54px plus 20px, and Danger zone is placed with margin 8px 0 -8px. (`apps/web/public/dashboard.css:160-161,220`)

## Organization data is unavailable (`WebLoadError`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- One centered empty state in the card, with readable fg2 text.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)

## Couldn't load members (`WebSectionError`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- The heading stays; one inline state with friendly copy, and no duplicate error toast.

Code notes:
- The error shows twice (toast and inline notice), the notice replaces the H1, and the text can be the raw Request failed (500). (`apps/web/public/dashboard.js:423-425,527-529,674-677`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)

## Personal is being prepared (`WebPersonalPreparing`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- While organizations load, the switcher row shows a skeleton; the page says one sentence per state.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- The empty-state h1 has no size, so it renders at the browser’s 28px bold; the state has three different messages. (`apps/web/public/dashboard.css:274 · apps/web/lib/dashboard.mjs:384 · apps/web/public/dashboard.js:501,621`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)

## Organization switcher · open (`WebOrgSwitcher`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- The switcher menu is the mac menu: bg3, border2, 12px corners, 28px rows, anchored under the switcher, the check at the end.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- The 280px popover overhangs the 232px sidebar column by 48px, with a 5px inset, 42px two-line rows and 0px corners. (`apps/web/public/dashboard.css:90-121`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)
- The column is min(100%, 980px) with 72px clamp(24px, 6vw, 92px) 96px padding, so labels sit about 800px from their controls. (`apps/web/public/dashboard.css:159`)

## Create organization · dialog (`WebCreateOrg`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- The dialog uses the proposed recipe over the whole window: 400px, 12px corners, a 16px inset, a 24px close and Ghost Cancel.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- Dialogs are 440px: one 20px-padded form, a 17px title, a 30px × text button, no footer divider and 0px corners. (`apps/web/public/dashboard.css:283-298`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)

## Delete organization · dialog (`WebDeleteOrg`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- No Workspaces group: Local workspaces belong to Local, and cloud organizations run cloud workspaces only, so the capability rows go.
- The confirm label names the organization: Type Acme to confirm.

Code notes:
- Remove Workspace access from General. Local workspaces belong to Local, which the web no longer shows; cloud organizations run cloud workspaces only, so the capability card has nothing to say. (`apps/web/lib/dashboard.mjs:355,362`)
- The confirm field says Enter the exact organization name but never shows the name. (`apps/web/lib/dashboard.mjs:487`)
- Dialogs are 440px: one 20px-padded form, a 17px title, a 30px × text button, no footer divider and 0px corners. (`apps/web/public/dashboard.css:283-298`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)

## Delete account · dialog (`WebDeleteAccount`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Local (Personal) is gone from the web: it can’t be used here, so the switcher lists cloud organizations, each with its own settings.
- The dialog uses the proposed recipe over the whole window with a destructive primary.

Code notes:
- Remove Local from the web dashboard. Local (Personal) can’t be used on the web and has no settings there; the switcher should list cloud organizations only, each with its own settings. (`apps/web/lib/dashboard.mjs:314,326-337,347-363,384,459 · apps/web/public/dashboard.css:56-121`)
- Dialogs are 440px: one 20px-padded form, a 17px title, a 30px × text button, no footer divider and 0px corners. (`apps/web/public/dashboard.css:283-298`)
- Descriptions and hints use muted-fg, 3.0:1 on cards; the mac app uses fg2 (8.6:1). (`apps/web/public/dashboard.css:164,190`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)

## Toast · after an action (`WebToast`)

Changes:
- Same anatomy as the mac Settings window: 256px sidebar, 32px rows with 14px icons, 12px group labels, a 640px column.
- Grouped cards: 12px corners, border1, 12 × 14 rows, 13 medium names with 12 fg3 hints, 28px controls.
- The Zeros logo leads the sidebar at the sign-in size: a 16px mark, 12px from the wordmark.
- Cloud organizations only: the org switcher is the first nav row; Sign out moves into Profile, as in the mac app.
- Toasts use the proposed recipe: bg3, border2, 12px corners, a status icon and a close; 24px from the corner.

Code notes:
- Toasts sit 20px from the corner with 11 × 13 padding, no icon or close, and stay 4.5 s for errors and successes alike. (`apps/web/public/dashboard.css:299-301 · apps/web/public/dashboard.js:382-390`)
- The invite row mixes a 34px input and select with a 32px button, so Send invite sits 2px short. (`apps/web/public/dashboard.css:233,254,263`)
- Rows are at least 58px with a 34px column for a 28px avatar and 10px initials; selects and × are 30px, badges 22px. (`apps/web/public/dashboard.css:75-85,228,249,265,272`)
- Eight control heights: badge 22, select 30, icon 30, button 32, menu action 34, input 34, org option 42 and switcher 44. (`apps/web/public/dashboard.css:59,108,121,195,228,233,249,272`)
- Sidebar content starts at five x positions (17–22px) with 18, 18, 16 and 5px gaps and 2px between rows. (`apps/web/public/dashboard.css:31-149`)
- Text characters stand in for icons (○ ◇ ♙ ▦ ▭ ⌄ ▣ ＋ × ✉), so size and baseline change with the font. (`apps/web/lib/dashboard.mjs:24,32,359,459,468-473 · apps/web/public/dashboard.js:549,563`)

## Account recovery required · / (`WebAccountRecovery`)

Changes:
- The account pages become centered pages: no sidebar holding only the brand, so nothing slides off on phones.
- One sentence and a single recovery-code row replace a notice, a card and a nested row.
- Without a code the page stops mentioning the code.

Code notes:
- Padding nests wrong: the Recoverable title touches the card edge while rows sit 20px in; the recovery-code row is inset 40px with a hairline that stops 20px short. (`apps/web/public/dashboard.js:494 · apps/web/lib/dashboard.mjs:247-249`)
- Copy drifts: Delete organization reads differently on server and client; recovery without a code still mentions the code; unverified email says verify first, then just try again. (`apps/web/lib/dashboard.mjs:248,363 · apps/web/public/dashboard.js:518 · apps/web/functions/auth/callback.ts:24,63`)
- These pages keep a 256px sidebar holding only the brand and account; at 760px and below it slides off screen and takes Sign out with it. (`apps/web/lib/dashboard.mjs:196-200,235-238,294-298 · apps/web/public/dashboard.css:304`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Every corner renders at 0px: the generated dashboard-tokens.css is cut before :root, so --radius-sm / md / lg never ship. (`apps/web/scripts/assemble-marketing.mjs:186-195 · apps/web/public/dashboard.css:50`)

## Account deletion scheduled · / (`WebAccountDeletion`)

Changes:
- The account pages become centered pages: no sidebar holding only the brand, so nothing slides off on phones.
- Sign out is a ghost beside Restore account instead of an 800px-wide bar; the repeated Restore account title is gone.

Code notes:
- Sign out is a button-styled link (a.button) in the flex column, so it stretches about 800px; the card title repeats its own button label. (`apps/web/lib/dashboard.mjs:304-305 · apps/web/public/dashboard.css:160`)
- These pages keep a 256px sidebar holding only the brand and account; at 760px and below it slides off screen and takes Sign out with it. (`apps/web/lib/dashboard.mjs:196-200,235-238,294-298 · apps/web/public/dashboard.css:304`)
- At 760px and below .card { padding: 16px } beats .settings-card { padding: 0 }: rows get a 36px inset and hairlines stop 16px short. (`apps/web/public/dashboard.css:176,317-321`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Every corner renders at 0px: the generated dashboard-tokens.css is cut before :root, so --radius-sm / md / lg never ship. (`apps/web/scripts/assemble-marketing.mjs:186-195 · apps/web/public/dashboard.css:50`)

## Use your existing sign-in · / (`WebAccessExisting`)

Changes:
- The account pages become centered pages with one primary.
- The 83-character summary and the notice become one line.

Code notes:
- These pages keep a 256px sidebar holding only the brand and account; at 760px and below it slides off screen and takes Sign out with it. (`apps/web/lib/dashboard.mjs:196-200,235-238,294-298 · apps/web/public/dashboard.css:304`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Every corner renders at 0px: the generated dashboard-tokens.css is cut before :root, so --radius-sm / md / lg never ship. (`apps/web/scripts/assemble-marketing.mjs:186-195 · apps/web/public/dashboard.css:50`)
- Geist is named first but never shipped, so pages fall back to Inter or the system font. (`apps/web/public/dashboard.css:9`)

## Sign in again · / (`WebAccessReauth`)

Changes:
- The account pages become centered pages with one primary.
- Sign in again is the main action instead of only Sign out.

Code notes:
- These pages keep a 256px sidebar holding only the brand and account; at 760px and below it slides off screen and takes Sign out with it. (`apps/web/lib/dashboard.mjs:196-200,235-238,294-298 · apps/web/public/dashboard.css:304`)
- Wrong or missing main action: a 13px Sign out link only, Get Zeros on an incomplete invite, Refresh beside a raw status. (`apps/web/lib/hub.ts:120,206,240 · apps/web/lib/invite-page.mjs:93 · apps/web/lib/workspace-page.mjs:70-72`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Every corner renders at 0px: the generated dashboard-tokens.css is cut before :root, so --radius-sm / md / lg never ship. (`apps/web/scripts/assemble-marketing.mjs:186-195 · apps/web/public/dashboard.css:50`)
- Geist is named first but never shipped, so pages fall back to Inter or the system font. (`apps/web/public/dashboard.css:9`)

## Account access unavailable · / (`WebAccessUnavailable`)

Changes:
- The account pages become centered pages with one primary.

Code notes:
- These pages keep a 256px sidebar holding only the brand and account; at 760px and below it slides off screen and takes Sign out with it. (`apps/web/lib/dashboard.mjs:196-200,235-238,294-298 · apps/web/public/dashboard.css:304`)
- Error notices keep muted text on red-bg (3.1:1); red-fg is set on the container but never reaches the title or paragraph. (`apps/web/public/dashboard.css:274-276`)
- Notices without a button pad 22px on top and 36px below (p margin 5px 0 14px), while cards pad 20px. (`apps/web/public/dashboard.css:169,273,275`)
- Every corner renders at 0px: the generated dashboard-tokens.css is cut before :root, so --radius-sm / md / lg never ship. (`apps/web/scripts/assemble-marketing.mjs:186-195 · apps/web/public/dashboard.css:50`)
- Geist is named first but never shipped, so pages fall back to Inter or the system font. (`apps/web/public/dashboard.css:9`)

## Page not found · 404.html (`WebNotFound`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 404 eyebrow becomes a 20px badge; the pill button becomes the 28px primary.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Not found · plain text (`WebNotFoundText`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The plain-text Not found becomes the 404 page.

Code notes:
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Restricted operations · ops.zeros.build (`WebOpsSignIn`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- An Ops badge sits beside the logo top-left instead of the zeros ops wordmark; the content is flex-centred, not pushed down 18vh.

Code notes:
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Reauthentication required · ops (`WebOpsReauth`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- The 85-character ceremony sentence becomes one short line.

Code notes:
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Access denied · ops (`WebOpsDenied`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- Sign out is a 28px secondary, not a 40px button at weight 650.

Code notes:
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Ops is unavailable · ops (`WebOpsUnavailable`)

Changes:
- One shell for every centered page: the Zeros logo top-left (16px mark, 12px gap), a 32px mark centered with no container, an 18/24 title, one line and a fit-width 28px action.
- No more dead end: Try again under the line.

Code notes:
- Dead end: the page offers no action. (`apps/web/lib/workos-desktop-authorization.mjs:59-69 · apps/web/functions/github/connected.ts:36-38 · apps/web/lib/ops.ts:196`)
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)
- Title sizes vary for the same role: 14 / 600, 14 / 650, a 32px hero, 18px, 30px (ops) and the browser’s 28px bold. (`apps/web/lib/page.ts:47-58 · apps/web/lib/invite-page.mjs:64 · apps/web/public/404.html:22 · apps/web/public/ops.css:11`)
- Four content widths (320, 360, 540, 420px) and six button recipes, from 37px pills to 48px hero buttons. (`apps/web/lib/page.ts:40-66 · apps/web/lib/invite-page.mjs:63,69 · apps/web/public/404.html:24-28`)
- Spacing is in rem and off the 4px grid: a 5.6px title gap and 9.6 / 10.4px button padding. (`apps/web/lib/page.ts:44-72 · apps/web/lib/invite-page.mjs:64-81`)
- Four page backgrounds (#0c0c0d, #121212, #09090b, white), mostly hard-coded hex. (`apps/web/lib/page.ts:36 · apps/web/lib/invite-page.mjs:59 · apps/web/public/ops.css:1,15`)

## Deletion recovery · developer (`WebOpsLookup`)

Changes:
- Ops uses the dashboard shell: a 256px sidebar, the 640px column and grouped cards.
- One 13px base with 28px controls replaces 16px paragraphs, 40px buttons and 42px inputs.
- Empty status lines take no space until there is text; failures read in red.

Code notes:
- Empty status paragraphs still take 36–52px each. (`apps/web/public/ops.css:38-39 · apps/web/lib/ops.ts:124,145,158,169`)
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)

## Deletion recovery · request found · platform owner (`WebOpsRequest`)

Changes:
- Ops uses the dashboard shell: a 256px sidebar, the 640px column and grouped cards.
- One 13px base with 28px controls replaces 16px paragraphs, 40px buttons and 42px inputs.
- Empty status lines take no space until there is text; failures read in red.
- The request is a card with a key-value list; Restore is the primary and Force purge a destructive-secondary.

Code notes:
- Empty status paragraphs still take 36–52px each. (`apps/web/public/ops.css:38-39 · apps/web/lib/ops.ts:124,145,158,169`)
- Failures render in info blue (.notice), not red. (`apps/web/public/ops.js:150-210 · apps/web/public/ops.css:39`)
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)

## Deletion recovery · force purge · developer (`WebOpsPurge`)

Changes:
- Ops uses the dashboard shell: a 256px sidebar, the 640px column and grouped cards.
- One 13px base with 28px controls replaces 16px paragraphs, 40px buttons and 42px inputs.
- Empty status lines take no space until there is text; failures read in red.
- The phrase sits in a red code chip inside a normal row.

Code notes:
- Failures render in info blue (.notice), not red. (`apps/web/public/ops.js:150-210 · apps/web/public/ops.css:39`)
- Ops has no base size: paragraphs and buttons are 16px, labels 13px; the h1 is 30px, buttons 40px and inputs 42px; cards are pushed down by margin 18vh. (`apps/web/public/ops.css:1-41`)
