import { useState } from "react";

const AGENT_FILE = {
  Claude: "/agents/claude.svg",
  Cursor: "/agents/cursor.svg",
  Codex: "/agents/codex.svg",
} as const;

export type AgentName = keyof typeof AGENT_FILE;

/**
 * Renders a reviewed static asset from /public/agents/. A neutral initial is
 * used if deployment omitted the file; fallback code does not duplicate marks.
 */
export function AgentLogoImg({
  name,
  className = "",
}: {
  name: AgentName;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span
        role="img"
        aria-label={`${name} logo unavailable`}
        className={`inline-flex items-center justify-center rounded-sm bg-bg2 text-[0.6em] font-semibold text-fg1 ${className}`}
      >
        {name.slice(0, 1)}
      </span>
    );
  }

  return (
    <img
      src={AGENT_FILE[name]}
      alt={`${name} logo`}
      draggable={false}
      onError={() => setFailed(true)}
      className={`${className} ${name === "Codex" ? "dark:invert" : ""}`}
    />
  );
}
