type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS = {
  sm: { mark: 'h-4 w-4', wordmark: 'h-[19px]' },
  md: { mark: 'h-[18px] w-[18px]', wordmark: 'h-[21px]' },
  lg: { mark: 'h-6 w-6', wordmark: 'h-[28px]' },
} as const

/**
 * Mark + SVG "Zeros" wordmark. Outfit Medium outlines (SIL OFL) with
 * a 110/120 size ratio on Z vs "eros", −2% tracking, shared baseline.
 * The mark is smaller than the name, Linear-style; the pair is
 * optically centered.
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
