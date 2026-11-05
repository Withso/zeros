// The one centred shell for app.zeros.build pages: sign-in, the desktop and
// GitHub handoffs, invitations, cloud workspaces, account states and Ops. It
// follows the Zeros Design canvas's Web app recipe: the Zeros logo top-left, a
// 32px mark, an 18/24 title, one line under it and fit-width 28px actions.
// Logos are inline SVG and the tokens are inline, so the shell renders the
// same under the nonce-only and `default-src 'none'` policies some pages use.

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

// BEGIN shared hosted-page shell: apps/control-plane/src/hosted-page.ts holds an
// identical copy (its test compares them), because the two deploy separately.
const MARK_PATH = "M0 0h1v1h-1ZM2 0h2v1h-1v1h-1ZM1 2h1v2h-2v-1h1ZM3 3h1v1h-1Z";

/** The Island Z mark, sized by its class. */
export function zerosMark(className: string): string {
  return `<svg class="${className}" viewBox="0 0 4 4" fill="currentColor" aria-hidden="true"><path d="${MARK_PATH}"/></svg>`;
}

const WORDMARK = `<svg class="brand-word" viewBox="26 -10 2563.2 730.9" fill="currentColor" aria-hidden="true"><path d="M34 620 416 80H551L169 620ZM34 700V620L133 595H543V700ZM57 105V0H551V80L451 105Z"/><path d="M854.4 710.9Q775.9 710.9 713.1 675.5Q650.4 640 613.9 577.8Q577.3 515.6 577.3 438.2Q577.3 360.7 613.3 299.1Q649.3 237.5 711 201.5Q772.6 165.5 847.9 165.5Q921 165.5 977.1 199.3Q1033.3 233.1 1065.5 292Q1097.7 350.9 1097.7 426.2Q1097.7 439.3 1096 452.9Q1094.4 466.5 1091.1 482.9H661.3V384.7H1029L984.2 424Q982 376 965.7 343.3Q949.3 310.5 919.3 293.1Q889.3 275.6 845.7 275.6Q799.9 275.6 766 295.3Q732.2 314.9 713.7 350.4Q695.1 385.8 695.1 434.9Q695.1 484 714.8 521.1Q734.4 558.2 770.4 578.4Q806.4 598.5 853.3 598.5Q893.7 598.5 928 584.4Q962.4 570.2 986.4 542.9L1062.8 620.4Q1024.6 665.1 970 688Q915.5 710.9 854.4 710.9Z"/><path d="M1174.6 700V176.4H1294.6V700ZM1294.6 408.7 1253.2 388Q1253.2 288.7 1297.4 227.1Q1341.5 165.5 1431 165.5Q1470.3 165.5 1501.9 179.6Q1533.5 193.8 1560.8 225.5L1482.3 306.2Q1468.1 290.9 1450.6 284.4Q1433.2 277.8 1410.3 277.8Q1360.1 277.8 1327.4 309.5Q1294.6 341.1 1294.6 408.7Z"/><path d="M1852.5 710.9Q1776.1 710.9 1714 674.4Q1651.8 637.8 1615.2 575.6Q1578.7 513.5 1578.7 437.1Q1578.7 360.7 1615.2 299.6Q1651.8 238.5 1714 202Q1776.1 165.5 1852.5 165.5Q1930 165.5 1992.1 201.5Q2054.3 237.5 2090.9 299.1Q2127.4 360.7 2127.4 437.1Q2127.4 513.5 2090.9 575.6Q2054.3 637.8 1992.1 674.4Q1930 710.9 1852.5 710.9ZM1852.5 595.3Q1897.2 595.3 1931.6 575.1Q1966 554.9 1985 518.9Q2004.1 482.9 2004.1 437.1Q2004.1 391.3 1984.5 356.4Q1964.9 321.5 1931 301.3Q1897.2 281.1 1852.5 281.1Q1808.9 281.1 1774.5 301.3Q1740.1 321.5 1721 356.4Q1702 391.3 1702 437.1Q1702 482.9 1721 518.9Q1740.1 554.9 1774.5 575.1Q1808.9 595.3 1852.5 595.3Z"/><path d="M2382.7 710.9Q2339 710.9 2298.7 699.5Q2258.3 688 2224.5 666.7Q2190.7 645.5 2165.6 614.9L2242 538.5Q2269.2 570.2 2304.7 586Q2340.1 601.8 2384.9 601.8Q2425.2 601.8 2446 589.8Q2466.7 577.8 2466.7 554.9Q2466.7 530.9 2447 517.8Q2427.4 504.7 2396.3 495.5Q2365.2 486.2 2330.9 476.4Q2296.5 466.5 2265.4 449.6Q2234.3 432.7 2214.7 403.3Q2195 373.8 2195 326.9Q2195 276.7 2218.5 240.7Q2242 204.7 2285 185.1Q2328.1 165.5 2388.1 165.5Q2451.4 165.5 2500 187.8Q2548.5 210.2 2581.2 254.9L2504.9 331.3Q2482 302.9 2452.5 288.7Q2423 274.5 2384.9 274.5Q2348.9 274.5 2329.2 285.5Q2309.6 296.4 2309.6 317.1Q2309.6 338.9 2329.2 350.9Q2348.9 362.9 2380 371.6Q2411 380.4 2445.4 390.7Q2479.8 401.1 2510.9 419.1Q2542 437.1 2561.6 467.1Q2581.2 497.1 2581.2 545.1Q2581.2 621.5 2527.8 666.2Q2474.3 710.9 2382.7 710.9Z"/></svg>`;


/** The shell's tokens: the values in styles/zeros-tokens.css (a test keeps them equal). */
export const SHELL_TOKENS = {
  dark: {
    "--bg1": "hsl(0 0% 7.843%)",
    "--bg1-bright": "hsl(0 0% 11%)",
    "--bg2": "hsl(0 0% 13%)",
    "--bg2-highlight": "hsl(0 0% 18%)",
    "--selected-bg": "hsl(0 0% 20.5%)",
    "--fg1": "hsl(0 0% 94%)",
    "--fg2": "hsl(0 0% 72%)",
    "--fg3": "hsl(0 0% 63%)",
    "--border1": "hsl(0 0% 14%)",
    "--border3": "hsl(0 0% 26.667%)",
    "--border4": "hsl(0 0% 34.118%)",
    "--highlighted-bright": "hsl(0 0% 79.216%)",
    "--inverted-bg": "hsl(0 0% 92%)",
    "--inverted-fg": "hsl(0 0% 5%)",
    "--primary-button-hover": "hsl(0 0% 83%)",
    "--red-fg": "hsl(2.05 100% 82.745%)",
    "--green-fg": "hsl(142 75% 73%)",
  },
  light: {
    "--bg1": "hsl(0 0% 100%)",
    "--bg1-bright": "hsl(36 20% 95.098%)",
    "--bg2": "hsl(36 20% 95.098%)",
    "--bg2-highlight": "hsl(36 7.937% 87.647%)",
    "--selected-bg": "hsl(36 7.937% 87.647%)",
    "--fg1": "hsl(30 10% 15.686%)",
    "--fg2": "hsl(30 5.195% 30.196%)",
    "--fg3": "hsl(30 4.396% 35.686%)",
    "--border1": "hsl(34.29 14.894% 90.784%)",
    "--border3": "hsl(33.33 8.108% 78.235%)",
    "--border4": "hsl(36 7.042% 72.157%)",
    "--highlighted-bright": "hsl(32.73 7.801% 27.647%)",
    "--inverted-bg": "hsl(30 10% 15.686%)",
    "--inverted-fg": "hsl(0 0% 100%)",
    "--primary-button-hover": "hsl(30 7.937% 24.706%)",
    "--red-fg": "hsl(358.21 63.81% 41.176%)",
    "--green-fg": "hsl(142 70% 27.5%)",
  },
} as const;

function tokenBlock(tokens: Record<string, string>): string {
  return Object.entries(tokens)
    .map(([name, value]) => `${name}: ${value};`)
    .join(" ");
}

/** The shell's stylesheet, shared verbatim with the control plane's hosted
 * pages (apps/control-plane/src/hosted-page.ts; a test keeps them equal). */
export const SHELL_CSS = `
      :root { color-scheme: dark; ${tokenBlock(SHELL_TOKENS.dark)} }
      @media (prefers-color-scheme: light) {
        :root { color-scheme: light; ${tokenBlock(SHELL_TOKENS.light)} }
      }
      * { box-sizing: border-box; }
      body {
        display: flex; min-height: 100vh; margin: 0; flex-direction: column;
        align-items: center; justify-content: center; padding: 96px 24px 64px;
        background: var(--bg1); color: var(--fg2);
        font: 13px/18px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      /* The Zeros logo top-left: a 16px mark, 12px from the wordmark. */
      .top { position: absolute; top: 24px; left: 32px; display: flex; align-items: center; gap: 10px; }
      .brand { display: inline-flex; align-items: center; gap: 12px; color: var(--fg1); text-decoration: none; }
      .brand-mark { width: 16px; height: 16px; }
      .brand-word { width: 58.6px; height: 16.7px; }
      .card { display: flex; width: 100%; max-width: 560px; flex-direction: column; align-items: center; text-align: center; }
      /* A 32px mark centred over the title, with no container. */
      .hero-logo { width: 32px; height: 32px; color: var(--fg1); }
      .badge {
        display: inline-flex; height: 20px; align-items: center; margin-top: 20px; padding: 0 6px;
        border-radius: 4px; background: var(--bg2); color: var(--fg2);
        font-size: 12px; line-height: 16px; font-weight: 450; white-space: nowrap;
      }
      .title, .hero-title {
        margin: 20px 0 0; color: var(--fg1); font-size: 18px; line-height: 24px;
        font-weight: 450; letter-spacing: -0.01em;
      }
      .badge + .title { margin-top: 8px; }
      .top .badge { margin-top: 0; }
      /* One line, up to 560px, wrapping only when it is longer. */
      .sub, .hero-sub { max-width: 560px; margin: 6px 0 0; color: var(--fg2); text-wrap: pretty; }
      .acts { display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; margin-top: 24px; }
      .acts.stack { width: 260px; flex-direction: column; align-items: stretch; }
      .acts:not(:has(> :not([hidden], .hidden))) { display: none; }
      /* Fit-width 28px actions that never underline. */
      a.btn, button.btn {
        display: inline-flex; align-items: center; justify-content: center; gap: 4px;
        padding: 4px 6px; border: 1px solid transparent; border-radius: 6px;
        background: var(--inverted-bg); color: var(--inverted-fg);
        font: inherit; font-weight: 450; white-space: nowrap; text-decoration: none; cursor: pointer;
        transition: color 120ms ease-out, background-color 120ms ease-out, border-color 120ms ease-out;
      }
      .btn svg { width: 14px; height: 14px; flex-shrink: 0; }
      a.btn:hover, button.btn:hover { background: var(--primary-button-hover); }
      a.btn.secondary, button.btn.secondary { border-color: var(--border3); background: transparent; color: var(--fg1); }
      a.btn.secondary:hover, button.btn.secondary:hover { border-color: var(--border4); background: var(--bg2-highlight); }
      a.btn.ghost, button.btn.ghost { background: transparent; color: var(--fg2); }
      a.btn.ghost:hover, button.btn.ghost:hover { background: var(--bg2-highlight); color: var(--fg1); }
      button.btn.ghost[aria-pressed="true"] { background: var(--selected-bg); color: var(--fg1); }
      .btn:focus-visible { outline: none; border-color: var(--highlighted-bright); box-shadow: 0 0 0 3px color-mix(in srgb, var(--highlighted-bright) 50%, transparent); }
      button.btn:disabled { opacity: 0.5; cursor: not-allowed; }
      a { color: var(--fg1); text-decoration: none; }
      .msg { max-width: 560px; margin: 12px 0 0; color: var(--fg2); font-size: 12px; line-height: 16px; }
      .msg:empty { margin: 0; }
      .msg.error, .error { color: var(--red-fg); }
      .msg.ok { color: var(--green-fg); }
      .meta { margin: 20px 0 0; color: var(--fg3); font-size: 12px; line-height: 16px; }
      .meta a { color: var(--fg1); font-weight: 500; }
      .box { width: 100%; max-width: 400px; margin-top: 20px; border: 1px solid var(--border1); border-radius: 12px; background: var(--bg1-bright); text-align: left; }
      .box-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; }
      .box-text { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
      .box-name { color: var(--fg1); font-weight: 450; }
      .box-hint { color: var(--fg3); font-size: 12px; line-height: 16px; }
      .box-ctl { display: flex; flex-shrink: 0; align-items: center; gap: 8px; }
      .icon-btn {
        display: inline-flex; width: 24px; height: 24px; flex-shrink: 0; align-items: center; justify-content: center;
        padding: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--fg2);
        cursor: pointer; transition: color 120ms ease-out, background-color 120ms ease-out;
      }
      .icon-btn svg { width: 12px; height: 12px; }
      .icon-btn:hover { background: var(--bg2-highlight); color: var(--fg1); }
      .icon-btn:focus-visible { outline: none; border-color: var(--highlighted-bright); box-shadow: 0 0 0 3px color-mix(in srgb, var(--highlighted-bright) 50%, transparent); }
      .code { flex-shrink: 0; color: var(--fg1); font: 12px/18px ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; letter-spacing: 0.02em; white-space: nowrap; }
      [hidden], .hidden { display: none !important; }
`;

/** The page document: the logo top-left, the 32px mark, then the content. */
export function shellDocument(
  title: string,
  inner: string,
  extra: { head?: string; styleAttributes?: string; badge?: string; topBadge?: string } = {},
): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />${extra.head ?? ""}
    <title>${title}</title>
    <style${extra.styleAttributes ?? ""}>${SHELL_CSS}    </style>
  </head>
  <body>
    <header class="top"><a class="brand" href="/" aria-label="Zeros home">${zerosMark("brand-mark")}${WORDMARK}</a>${extra.topBadge ?? ""}</header>
    <main class="card">${zerosMark("hero-logo")}${extra.badge ?? ""}${inner}</main>
  </body>
</html>`;
}
// END shared hosted-page shell

/** The logo for the dashboard's sidebar and mobile header. */
export const BRAND_LOGO = `${zerosMark("brand-mark")}${WORDMARK}`;

/** Provider logos for the sign-in buttons: Google in its colours, GitHub in the button's. */
export const PROVIDER_LOGOS = {
  google: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`,
  github: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>`,
} as const;

export interface ShellOptions {
  /** A CSP nonce for the inline stylesheet, for pages with a nonce-only policy. */
  nonce?: string;
  /** A neutral badge above the title, such as "404". */
  badge?: string;
  /** A neutral badge beside the logo, such as "Ops". */
  headerBadge?: string;
  /** Extra head tags, such as a noscript style. */
  head?: string;
  /** Kept for callers: every centred page shares the one scale. */
  presentation?: "compact" | "hero";
}

export function shell(title: string, inner: string, options: ShellOptions = {}): string {
  return shellDocument(title, inner, {
    ...(options.head ? { head: `\n    ${options.head}` } : {}),
    ...(options.nonce ? { styleAttributes: ` nonce="${esc(options.nonce)}"` } : {}),
    ...(options.badge ? { badge: `<span class="badge">${esc(options.badge)}</span>` } : {}),
    ...(options.headerBadge ? { topBadge: `<span class="badge">${esc(options.headerBadge)}</span>` } : {}),
  });
}
