type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and wordmark together. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE_CLASS = {
  sm: { mark: 'h-4 w-4', wordmark: 'h-[11px]' },
  md: { mark: 'h-[18px] w-[18px]', wordmark: 'h-[12px]' },
  lg: { mark: 'h-6 w-6', wordmark: 'h-[16px]' },
} as const

/**
 * Mark + SVG "Zeros" wordmark. Outfit Medium outlines (SIL OFL) with
 * a 110/120 size ratio on Z vs "eros", −2% tracking, shared baseline.
 * Header scale matches Linear: 24px mark, ~16px name so cap-height
 * sits inside the blobs; 8px gap between mark and name.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { mark, wordmark } = SIZE_CLASS[size]
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
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
