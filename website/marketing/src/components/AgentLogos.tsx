/*
 * Drop the official SVG for each agent at:
 *   public/agents/claude.svg
 *   public/agents/cursor.svg
 *   public/agents/codex.svg
 *
 * <AgentLogoImg> below renders that file as an <img>. If a file is
 * missing, the corresponding fallback SVG component in this file is
 * rendered instead, so the UI never breaks.
 */

import { useState } from 'react'

type IconProps = { className?: string }

/* Anthropic-style burst: 4 long curved petals at 45° + 4 short petals at 90°. */
export function ClaudeLogo({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 28 28" className={className} aria-hidden>
      <g fill="#D97757">
        {[45, 135, 225, 315].map((a) => (
          <path
            key={`l-${a}`}
            transform={`rotate(${a} 14 14)`}
            d="M14 2.6 C 15.55 5 16.2 8.4 14 14 C 11.8 8.4 12.45 5 14 2.6 Z"
          />
        ))}
        {[0, 90, 180, 270].map((a) => (
          <path
            key={`s-${a}`}
            transform={`rotate(${a} 14 14)`}
            d="M14 5.2 C 15.05 7.4 15.5 10 14 14 C 12.5 10 12.95 7.4 14 5.2 Z"
          />
        ))}
      </g>
    </svg>
  )
}

/* Cursor-style angular wedge / cursor pointer (white). */
export function CursorLogo({ className = '' }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#F4F4F6"
        d="M5 2.6 L20.4 11.8 L13.05 12.55 L11.35 20.4 Z"
      />
    </svg>
  )
}

/* OpenAI Codex brand mark — distinct from the OpenAI rosette. */
export function CodexLogo({ className = '' }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="#F4F4F6"
      fillRule="evenodd"
      className={className}
      aria-hidden
    >
      <path
        clipRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
    </svg>
  )
}

export const agentLogo = {
  Claude: ClaudeLogo,
  Cursor: CursorLogo,
  Codex: CodexLogo,
} as const

export type AgentName = keyof typeof agentLogo

const AGENT_FILE: Record<AgentName, string> = {
  Claude: '/agents/claude.svg',
  Cursor: '/agents/cursor.svg',
  Codex: '/agents/codex.svg',
}

/**
 * Renders the per-agent brand file from /public/agents/. Falls back to
 * the inline SVG component above if the file is missing.
 */
export function AgentLogoImg({
  name,
  className = '',
}: {
  name: AgentName
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  const Fallback = agentLogo[name]

  if (failed) return <Fallback className={className} />

  return (
    <img
      src={AGENT_FILE[name]}
      alt={name}
      draggable={false}
      onError={() => setFailed(true)}
      className={`${className} ${name === 'Codex' ? 'invert' : ''}`}
    />
  )
}
