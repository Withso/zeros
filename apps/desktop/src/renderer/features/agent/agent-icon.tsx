// ──────────────────────────────────────────────────────────
// AgentIcon — branded agent logo renderer
// ──────────────────────────────────────────────────────────
//
// Renders a bundled SVG (zero network) when one exists for the
// agent, falling back to fetching a served SVG otherwise. Either
// way it rewrites `currentColor` to the agent's brand color (from
// agent-brands.ts) and inlines the result so the logo renders in
// its real brand color. Caches per-icon-url so any fetch is paid
// at most once per session.
// ──────────────────────────────────────────────────────────

import React, { useEffect, useState } from "react";
import { Bot } from "lucide-react";
import DOMPurify from "dompurify";
import { brandColor } from "./agent-brands";
import { bundledAgentSvg } from "./agent-icons-bundled";

const svgCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function recolor(raw: string, color: string | null): string {
  if (!color) return raw;
  // Replace any `fill="currentColor"` / `stroke="currentColor"` and
  // the CSS style variant. Keeps the original geometry intact.
  return raw
    .replace(/fill="currentColor"/gi, `fill="${color}"`)
    .replace(/stroke="currentColor"/gi, `stroke="${color}"`)
    .replace(/fill:\s*currentColor/gi, `fill:${color}`)
    .replace(/stroke:\s*currentColor/gi, `stroke:${color}`);
}

async function fetchSvg(url: string): Promise<string> {
  const existing = inFlight.get(url);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // The icon URL comes from registry metadata and is injected via
    // dangerouslySetInnerHTML. A malicious/MITM'd icon host could serve
    // `<img src=x onerror=…>` / `<svg><animate onbegin>` etc. Sanitize to the
    // SVG profile (strips scripts + event handlers, keeps geometry) BEFORE we
    // cache it, so recolor() and the inject both operate on safe markup.
    const safe = DOMPurify.sanitize(text, {
      USE_PROFILES: { svg: true, svgFilters: true },
    });
    svgCache.set(url, safe);
    return safe;
  })();
  inFlight.set(url, p);
  try {
    return await p;
  } finally {
    inFlight.delete(url);
  }
}

export interface AgentIconProps {
  agentId: string | null | undefined;
  iconUrl: string | null | undefined;
  size?: number;
  className?: string;
  /** Fallback color when the agent has no brand entry. Defaults to
   *  the theme's muted text color. */
  fallbackColor?: string;
  /** When true, skip the brand-color recolor
   *  and let the SVG's `currentColor` cascade from CSS. Used by the
   *  summary-pill row so logos render in a single neutral tone, not
   *  rainbow brand-colors. The full-color path stays default. */
  monochrome?: boolean;
}

export function AgentIcon({
  agentId,
  iconUrl,
  size = 16,
  className,
  fallbackColor,
  monochrome = false,
}: AgentIconProps) {
  const color = monochrome
    ? null
    : (brandColor(agentId) ?? fallbackColor ?? null);
  // Prefer the bundled SVG keyed by agentId — zero network, zero CSP
  // friction, no engine-restart dependency. The URL fetch path stays
  // as a fallback for agents we haven't vendored locally yet (e.g.
  // future additions whose mark hasn't been added to apps/desktop/src/assets/agents/).
  const bundled = bundledAgentSvg(agentId ?? null);
  const [svg, setSvg] = useState<string | null>(() => {
    if (bundled) return bundled;
    return iconUrl ? (svgCache.get(iconUrl) ?? null) : null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (bundled) {
      setSvg(bundled);
      setFailed(false);
      return;
    }
    if (!iconUrl) {
      setSvg(null);
      setFailed(false);
      return;
    }
    const cached = svgCache.get(iconUrl);
    if (cached) {
      setSvg(cached);
      setFailed(false);
      return;
    }
    let cancelled = false;
    setFailed(false);
    fetchSvg(iconUrl)
      .then((raw) => {
        if (cancelled) return;
        setSvg(raw);
      })
      .catch(() => {
        if (cancelled) return;
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [bundled, iconUrl]);

  const style: React.CSSProperties = {
    width: size,
    height: size,
    // The lobehub SVGs declare width="1em" height="1em" so the icon
    // sizes off the parent's font-size. Pinning font-size to the
    // requested pixel value makes the inner SVG render at exactly
    // `size` px regardless of cascade — without this every icon
    // inherited the page's body font-size (~13px) and ignored the
    // size prop entirely.
    fontSize: size,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
  };

  // Render the lucide Bot fallback only when we have NO source for an
  // SVG: no bundled vendor file AND no working URL fetch. Pre-fix this
  // condition was `failed || !iconUrl`, which hit the fallback path
  // even for agents whose icons are bundled locally (since the
  // EmptyComposer's chip path doesn't pass an iconUrl prop — it
  // expects bundling to handle the mark from agentId alone).
  if (!bundled && (failed || !iconUrl)) {
    return (
      <span className={className} style={style} aria-hidden="true">
        <Bot size={Math.round(size * 0.75)} />
      </span>
    );
  }

  if (!svg) {
    return <span className={className} style={style} aria-hidden="true" />;
  }

  const colored = recolor(svg, color);
  return (
    <span
      className={className}
      style={style}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: colored }}
    />
  );
}
