import { NAV_LINKS } from '../lib/site'
import { BrandLockup } from './BrandLockup'
import { DownloadButton } from './DownloadButton'

/**
 * Sticky top nav that shares the page canvas — no border, no frost —
 * so the lockup sits on bg1. Logo left, links + Download on the right.
 * Text links collapse on small screens, leaving logo + Download.
 */
export function Nav() {
  return (
    <header className="sticky top-0 z-50 bg-bg1">
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between px-5 sm:px-8 lg:px-10">
        <a href="/" className="select-none" aria-label="Zeros home">
          <BrandLockup size="lg" />
        </a>

        <nav className="flex items-center gap-1 sm:gap-2">
          <div className="mr-1 hidden items-center sm:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.label}
                href={link.href}
                target={link.external ? '_blank' : undefined}
                rel={link.external ? 'noreferrer' : undefined}
                className="rounded-md px-3 py-1.5 text-[13px] text-fg2 transition-colors hover:text-fg1"
              >
                {link.label}
              </a>
            ))}
          </div>
          <span
            aria-hidden
            className="mx-1 hidden h-4 w-px bg-border2 sm:block"
          />
          <DownloadButton size="sm" label="Download" />
        </nav>
      </div>
    </header>
  )
}
