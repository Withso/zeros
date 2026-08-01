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
  options: { presentation?: "compact" | "hero" } = {},
): string {
  const cardClass =
    options.presentation === "hero" ? "card card-hero" : "card";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        font: 14px -apple-system, system-ui, sans-serif;
        background: #0c0c0d; color: #e6e6e6;
        display: flex; min-height: 100vh; margin: 0;
        align-items: center; justify-content: center;
      }
      .card { width: 100%; max-width: 320px; padding: 0 1.5rem; text-align: center; }
      .card-hero { max-width: 540px; }
      .hero-logo {
        width: 56px; height: 56px; box-sizing: border-box;
        margin-bottom: 2rem; padding: 10px; border-radius: 14px;
        background: #18181b; border: 1px solid #3f3f46;
      }
      .hero-title {
        color: #f4f4f5; font-size: 32px; line-height: 1.2;
        font-weight: 600; letter-spacing: -0.02em; margin-bottom: 0.75rem;
      }
      .hero-sub {
        max-width: 440px; margin: 0 auto 2rem; color: #a1a1aa;
        font-size: 16px; line-height: 1.5;
      }
      .card-hero .btn { min-height: 48px; font-size: 16px; }
      [hidden] { display: none !important; }
      .title { font-weight: 600; color: #f4f4f5; margin-bottom: 0.35rem; }
      .sub { color: #a1a1aa; font-size: 13px; line-height: 1.5; margin-bottom: 1.5rem; }
      a.btn, button.btn {
        display: flex; align-items: center; justify-content: center;
        width: 100%; box-sizing: border-box;
        margin-top: 0.6rem; padding: 0.6rem 1rem;
        color: #0c0c0d; font: inherit; font-weight: 600; cursor: pointer;
        text-decoration: none; background: #ffffff;
        border: 1px solid #ffffff; border-radius: 8px;
      }
      a.btn:hover, button.btn:hover { background: #e6e6e6; }
      a.btn.secondary, button.btn.secondary {
        background: transparent; color: #e6e6e6; border-color: #3f3f46;
      }
      a.btn.secondary:hover, button.btn.secondary:hover { background: #18181b; }
      .msg { color: #a1a1aa; font-size: 13px; margin-top: 0.75rem; }
    </style>
  </head>
  <body><div class="${cardClass}">${inner}</div></body>
</html>`;
}
