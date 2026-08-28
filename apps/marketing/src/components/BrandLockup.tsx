type BrandLockupProps = {
  /** Logo scale; sizes the combined mark + wordmark SVG. */
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

// Combined lockup SVG is 356×59. Height is the only free variable — width
// follows so the designed icon-to-wordmark spacing stays intact.
const SIZE_CLASS = {
  sm: 'h-[18px]',
  md: 'h-[22px]',
  lg: 'h-7',
} as const

/**
 * Official Zeros lockup (mark + lowercase wordmark) from ZEROS-logo-name.svg.
 */
export function BrandLockup({ size = 'md', className = '' }: BrandLockupProps) {
  const height = SIZE_CLASS[size]
  return (
    <span className={`inline-flex items-center leading-none ${className}`}>
      <img
        src="/ZEROS-logo-name.svg"
        alt="Zeros"
        className={`${height} w-auto object-contain invert dark:invert-0`}
        draggable={false}
      />
    </span>
  )
}
