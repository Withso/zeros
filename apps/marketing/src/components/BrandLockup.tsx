type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and "Zeros" wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

// Mark sits a touch taller than cap height — Linear's lockup proportion.
const SIZE_CLASS = {
  sm: { text: 'text-[16px]', mark: 'h-5 w-5' },
  md: { text: 'text-[16px]', mark: 'h-[22px] w-[22px]' },
  lg: { text: 'text-[18px]', mark: 'h-7 w-7' },
} as const

/**
 * Mark + "Zeros" wordmark. The name is Geist medium at the same weight as
 * the homepage tagline, title case, vertically centered on the mark.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { text, mark } = SIZE_CLASS[size]
  return (
    <span
      className={`inline-flex items-center gap-[0.4em] font-sans leading-none text-fg1 ${text} ${className}`}
    >
      <img
        src="/zeros-logo.svg"
        alt=""
        className={`${mark} shrink-0 object-contain invert dark:invert-0`}
        draggable={false}
      />
      <span className="font-medium tracking-[-0.03em]">Zeros</span>
    </span>
  )
}
