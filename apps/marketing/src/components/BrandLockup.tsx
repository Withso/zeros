type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

// Name is larger than the mark's cap-height so the wordmark leads.
// items-end sits both on one baseline.
const SIZE_CLASS = {
  sm: { text: 'text-[18px]', mark: 'h-5 w-5' },
  md: { text: 'text-[18px]', mark: 'h-[22px] w-[22px]' },
  lg: { text: 'text-[24px]', mark: 'h-8 w-8' },
} as const

/**
 * Mark + "Zeros" wordmark, bottom-aligned. Medium weight matches the
 * homepage tagline. Lowercase was tried and dropped — the x-height
 * made the name look smaller than the mark. Title case matches Linear.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { text, mark } = SIZE_CLASS[size]
  return (
    <span
      className={`inline-flex items-end gap-[0.32em] font-sans leading-none text-fg1 ${text} ${className}`}
    >
      <img
        src="/zeros-logo.svg"
        alt=""
        className={`${mark} shrink-0 object-contain invert dark:invert-0`}
        draggable={false}
      />
      <span className="font-medium tracking-[0.04em]">Zeros</span>
    </span>
  )
}
