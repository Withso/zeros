import { NAV_LINKS } from '../lib/site'
import { BrandLockup } from './BrandLockup'
import { DownloadButton } from './DownloadButton'

/**
 * Sticky, translucent top nav. Logo left, links + download right.
 * Text links collapse on small screens, leaving logo + Download.
 */
export function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-border1 bg-bg1/75 backdrop-blur-xl">
      <div className="mx-auto flex h-14 w-full max-w-[1240px] items-center justify-between px-5 sm:px-8 lg:px-10">
        <a href="/" className="select-none" aria-label="Zeros home">
          <BrandLockup size="md" />
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
          <DownloadButton size="sm" label="Download" />
        </nav>
      </div>
    </header>
  )
}
