type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and "Zeros" wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

// Mark (icon) and wordmark are sized independently — the mark sits a touch
// taller than the cap height, same proportion as a Linear-style lockup.
const SIZE_CLASS = {
  sm: { text: 'text-[16px]', mark: 'h-[18px] w-[18px]' },
  md: { text: 'text-[16px]', mark: 'h-[20px] w-[20px]' },
  lg: { text: 'text-[18px]', mark: 'h-7 w-7' },
} as const

/**
 * Logo mark + "Zeros" wordmark, vertically centered as one lockup.
 * Wordmark is medium weight so it reads like Linear's name, not a light caption.
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
      <span className="font-medium tracking-[-0.02em]">Zeros</span>
    </span>
  )
}
