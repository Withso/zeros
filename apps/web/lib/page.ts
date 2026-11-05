// Shared HTML shell for app.zeros.build pages — the hub (lib/hub.ts) and the
// auth error pages (functions/auth/callback.ts) render into the same chrome so
// the whole sign-in journey looks like one product surface.

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function shell(
  title: string,
  inner: string,
  // "hero" pages (GitHub handoff) share the one centred scale; kept for callers.
  _options: { presentation?: "compact" | "hero" } = {},
): string {
  // Every centred page carries the 32px mark above its title, except pages
  // that place their own (the GitHub handoff's hero-logo).
  const mark = inner.includes('class="hero-logo"')
    ? ""
    : '<img class="hero-logo" src="/zeros-logo.svg" alt="" />';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>
      /* The app's tokens (styles/zeros-tokens.css), so Light works too. */
      :root {
        color-scheme: dark;
        --bg1: hsl(0 0% 7.843%); --fg1: hsl(0 0% 94%); --fg2: hsl(0 0% 72%);
        --fg3: hsl(0 0% 63%); --border3: hsl(0 0% 26.667%); --bg2-highlight: hsl(0 0% 18%);
        --primary-bg: hsl(0 0% 92%); --primary-fg: hsl(0 0% 5%); --primary-hover: hsl(0 0% 83%);
        --red-fg: hsl(2.05 100% 82.745%);
      }
      @media (prefers-color-scheme: light) {
        :root {
          color-scheme: light;
          --bg1: hsl(0 0% 100%); --fg1: hsl(30 10% 15.686%); --fg2: hsl(30 5.195% 30.196%);
          --fg3: hsl(30 4.396% 35.686%); --border3: hsl(33.33 8.108% 78.235%); --bg2-highlight: hsl(36 7.937% 87.647%);
          --primary-bg: hsl(30 10% 15.686%); --primary-fg: hsl(0 0% 100%); --primary-hover: hsl(30 7.937% 24.706%);
          --red-fg: hsl(358.21 63.81% 41.176%);
        }
      }
      body {
        font: 13px/18px -apple-system, system-ui, sans-serif;
        background: var(--bg1); color: var(--fg1);
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center;
      }
      /* The Zeros logo top-left: a 16px mark, 12px from the wordmark. */
      .brand {
        position: fixed; top: 16px; left: 16px;
        display: inline-flex; align-items: center; gap: 12px;
        color: var(--fg1); font-weight: 600; text-decoration: none;
      }
      .brand img { width: 16px; height: 16px; }
      .card { width: 100%; max-width: 560px; padding: 0 1.5rem; text-align: center; box-sizing: border-box; }
      /* A 32px mark centred over the title, with no container. */
      .hero-logo {
        display: block; width: 32px; height: 32px; margin: 0 auto 16px;
        padding: 0; border: 0; border-radius: 0; background: none;
      }
      [hidden] { display: none !important; }
      .title, .hero-title {
        color: var(--fg1); font-size: 18px; line-height: 24px;
        font-weight: 600; letter-spacing: 0; margin: 0 0 4px;
      }
      /* One line, up to 560px, wrapping only when it is longer. */
      .sub, .hero-sub {
        max-width: 560px; margin: 0 auto 20px; color: var(--fg2);
        font-size: 13px; line-height: 18px;
      }
      /* Fit-width 28px actions that never underline. */
      a.btn, button.btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 6px;
        height: 28px; box-sizing: border-box; margin: 4px;
        padding: 0 12px; color: var(--primary-fg); font: inherit; font-weight: 500;
        cursor: pointer; text-decoration: none; white-space: nowrap;
        background: var(--primary-bg); border: 1px solid var(--primary-bg); border-radius: 6px;
      }
      a.btn:hover, button.btn:hover { background: var(--primary-hover); border-color: var(--primary-hover); }
      a.btn.secondary, button.btn.secondary {
        background: transparent; color: var(--fg1); border-color: var(--border3);
      }
      a.btn.secondary:hover, button.btn.secondary:hover { background: var(--bg2-highlight); }
      a { color: var(--fg1); text-decoration: none; }
      .msg { color: var(--fg3); font-size: 12px; line-height: 16px; margin-top: 12px; }
      .msg.error, .error { color: var(--red-fg); }
    </style>
  </head>
  <body>
    <a class="brand" href="/"><img src="/zeros-logo.svg" alt="" />Zeros</a>
    <div class="card">${mark}${inner}</div>
  </body>
</html>`;
}
