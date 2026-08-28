type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS = {
  sm: { mark: 'h-5 w-5', wordmark: 'h-[15px]' },
  md: { mark: 'h-[22px] w-[22px]', wordmark: 'h-[17px]' },
  lg: { mark: 'h-8 w-8', wordmark: 'h-[25px]' },
} as const

/**
 * Mark + SVG "Zeros" wordmark. The name is Outfit Medium outlines
 * (SIL OFL), converted to paths with Linear-like tight tracking
 * and a slightly enlarged o so it rhymes with the blob circles.
 * Cap height is ~75% of the mark; the pair is optically centered.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { mark, wordmark } = SIZE_CLASS[size]
  return (
    <span className={`inline-flex items-center gap-[7px] ${className}`}>
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
