/** Presentation-only artwork carried inside a tool's existing rawInput. It
 * grants no capability and must never be treated as a trusted status badge. */
export interface ToolArtwork {
  icon: string;
  iconDark?: string;
  name?: string;
}

/** Images render in an img element, never as inline SVG/HTML. Reject files,
 * active schemes, credentials and local network destinations. Public HTTPS
 * artwork is loaded anonymously; missing/invalid artwork uses existing icons. */
export function safeToolImageSource(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  if (value.length <= 96 * 1024) {
    if (
      /^data:image\/(?:png|jpeg|webp|gif|x-icon);base64,[A-Za-z0-9+/]+={0,2}$/.test(
        value,
      )
    )
      return value;
    if (/^data:image\/svg\+xml;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      try {
        const svg = atob(value.slice(value.indexOf(",") + 1));
        if (
          !/^\s*(?:<\?xml[^>]*>\s*)?<svg\b/i.test(svg) ||
          /<!|<\?xml-stylesheet|<(?:script|foreignObject|iframe|object|embed|animate\w*|set)\b|\son[a-z]+\s*=|@import\b|image-set\s*\(/i.test(
            svg,
          )
        )
          return;
        if (
          [
            ...svg.matchAll(/\b(?:href|xlink:href)\s*=\s*["']([^"']*)["']/gi),
          ].some((match) => !match[1]?.trim().startsWith("#"))
        )
          return;
        if (
          [...svg.matchAll(/url\s*\(\s*(["']?)([^)"']+)\1\s*\)/gi)].some(
            (match) => !match[2]?.trim().startsWith("#"),
          )
        )
          return;
        return value;
      } catch {
        return;
      }
    }
  }
  if (value.length > 8192) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return;
    if (
      !host.includes(".") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
    )
      return;
    return url.href;
  } catch {
    /* no usable image */
  }
}
