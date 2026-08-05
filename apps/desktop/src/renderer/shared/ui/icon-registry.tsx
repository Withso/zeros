// ──────────────────────────────────────────────────────────
// Icon registry — Lucide-name-string → component
// ──────────────────────────────────────────────────────────
//
// Run actions persist their icon as a Lucide NAME STRING in settings.toml
// (the Skills precedent — a string survives schema evolution and TOML
// hand-edits). Nothing in the app rendered a stored icon name dynamically
// before this; every consumer (tabs, header split-button, menu items,
// settings cards, the picker grid) goes through <DynamicIcon> now.
//
// The set is CURATED (the 12 dev-relevant glyphs from the state-catalog
// review — "enough for now"), not all ~1,500 Lucide icons: a searchable grid
// over a dozen icons stays instant and the registry stays tree-shakeable.
// Room to grow — adding an icon is one entry here. Unknown / renamed names
// fall back to the default glyph instead of crashing (the Skills "Sparkles"
// fallback precedent).
// ──────────────────────────────────────────────────────────

import {
  Bug,
  Cloud,
  Database,
  FlaskConical,
  Globe,
  Package,
  Play,
  Plug,
  RotateCw,
  Settings,
  Terminal,
  Wrench,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

/** One pickable icon: its persisted name (Lucide kebab-case), the component,
 *  and search keywords for the picker's filter. */
export interface RegisteredIcon {
  name: string;
  Icon: LucideIcon;
  keywords: string[];
}

/** The curated picker set, in display order. */
export const RUN_ICONS: RegisteredIcon[] = [
  { name: "play", Icon: Play, keywords: ["run", "start", "dev"] },
  {
    name: "flask-conical",
    Icon: FlaskConical,
    keywords: ["test", "lab", "experiment"],
  },
  { name: "bug", Icon: Bug, keywords: ["debug", "issue"] },
  { name: "wrench", Icon: Wrench, keywords: ["build", "tool", "fix"] },
  { name: "package", Icon: Package, keywords: ["bundle", "install", "deps"] },
  { name: "globe", Icon: Globe, keywords: ["web", "server", "preview"] },
  { name: "database", Icon: Database, keywords: ["db", "sql", "migrate"] },
  { name: "cloud", Icon: Cloud, keywords: ["deploy", "remote"] },
  { name: "terminal", Icon: Terminal, keywords: ["shell", "cli", "console"] },
  { name: "settings", Icon: Settings, keywords: ["config", "gear"] },
  {
    name: "rotate-cw",
    Icon: RotateCw,
    keywords: ["restart", "refresh", "watch"],
  },
  { name: "plug", Icon: Plug, keywords: ["connect", "socket", "api"] },
];

const BY_NAME = new Map(RUN_ICONS.map((i) => [i.name, i.Icon]));

/** The fallback glyph for an unknown / unset icon name. */
export const DEFAULT_RUN_ICON = "play";

/** Resolve a persisted icon name to its component (fallback for unknowns). */
export function resolveIcon(name: string | undefined | null): LucideIcon {
  return (name && BY_NAME.get(name)) || Play;
}

/** Render a persisted Lucide icon name. Run-action glyphs default to the
 *  product's 1px stroke; callers can still override any Lucide prop. */
export function DynamicIcon({
  name,
  strokeWidth = 1,
  ...props
}: { name: string | undefined | null } & LucideProps) {
  const Icon = resolveIcon(name);
  return <Icon strokeWidth={strokeWidth} {...props} />;
}
