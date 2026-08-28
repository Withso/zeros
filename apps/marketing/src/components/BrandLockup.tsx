type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS = {
  sm: { mark: 'h-5 w-5', wordmark: 'h-[15px]' },
  md: { mark: 'h-[22px] w-[22px]', wordmark: 'h-[18px]' },
  lg: { mark: 'h-8 w-8', wordmark: 'h-[26px]' },
} as const

/**
 * Mark + custom SVG "zeros" wordmark. The name is drawn, not set in
 * type, so its round terminals and circular o match the four-blob
 * mark. Optically centered like a Linear lockup; the wordmark sits at
 * ~80% of the mark height.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { mark, wordmark } = SIZE_CLASS[size]
  return (
    <span className={`inline-flex items-center gap-[6px] ${className}`}>
      <img
        src="/zeros-logo.svg"
        alt=""
        className={`${mark} shrink-0 object-contain invert dark:invert-0`}
        draggable={false}
      />
      <img
        src="/zeros-wordmark.svg"
        alt=""
        className={`${wordmark} w-auto invert dark:invert-0`}
        draggable={false}
      />
    </span>
  )
}
