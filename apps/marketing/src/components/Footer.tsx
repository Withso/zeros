import { DOCS_URL, DOWNLOAD_URL, GITHUB_URL } from '../lib/site'
import { BrandLockup } from './BrandLockup'

type FooterLink = { label: string; href: string; external?: boolean }

const COLUMNS: { title: string; links: FooterLink[] }[] = [
  {
    title: 'Product',
    links: [
      { label: 'Download for Mac', href: DOWNLOAD_URL, external: true },
      { label: 'Changelog', href: '/changelog' },
      { label: 'Docs', href: DOCS_URL },
    ],
  },
  {
    title: 'Resources',
    links: [
      { label: 'GitHub', href: GITHUB_URL, external: true },
      { label: 'Send feedback', href: 'mailto:hello@zeros.build' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
    ],
  },
]

export function Footer() {
  return (
    <footer className="border-t border-border1">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-12 sm:px-8 lg:px-10 lg:py-16">
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          {/* Brand */}
          <div className="max-w-[280px]">
            <BrandLockup size="md" />
            <p className="mt-4 text-[13px] leading-[1.6] text-fg3">
              A Mac workspace where parallel AI agents design, build, and ship —
              across isolated worktrees.
            </p>
          </div>

          {/* Link columns */}
          <div className="grid grid-cols-2 gap-8 sm:grid-cols-3 sm:gap-14">
            {COLUMNS.map((col) => (
              <div key={col.title}>
                <h3 className="text-[12px] font-medium tracking-wide text-fg2 uppercase">
                  {col.title}
                </h3>
                <ul className="mt-3 flex flex-col gap-2.5">
                  {col.links.map((link) => (
                    <li key={link.label}>
                      <a
                        href={link.href}
                        target={link.external ? '_blank' : undefined}
                        rel={link.external ? 'noreferrer' : undefined}
                        className="text-[13px] text-fg3 transition-colors hover:text-fg1"
                      >
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-12 flex items-center justify-between text-[12px] text-fg3">
          <span>© {new Date().getFullYear()} Zeros</span>
        </div>
      </div>
    </footer>
  )
}
