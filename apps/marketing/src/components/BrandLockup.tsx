type BrandLockupProps = {
  /** Logo scale; sizes the icon mark and "ZEROS" wordmark together. */
  size?: 'sm' | 'md'
  className?: string
}

// Mark (icon) and wordmark are sized independently — the mark reads a touch
// larger than the text so the icon anchors the lockup.
const SIZE_CLASS = {
  sm: { text: 'text-[16px]', mark: 'h-[18px] w-[18px]' },
  md: { text: 'text-[16px]', mark: 'h-[20px] w-[20px]' },
} as const

/**
 * Logo mark + "ZEROS" wordmark, vertically centered as one lockup.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const { text, mark } = SIZE_CLASS[size]
  return (
    <span
      className={`inline-flex items-center gap-[0.36em] font-sans leading-none text-fg1 ${text} ${className}`}
    >
      <img
        src="/zeros-logo.svg"
        alt=""
        className={`${mark} shrink-0 object-contain`}
        draggable={false}
      />
      <span className="font-normal">Zeros</span>
    </span>
  )
}
