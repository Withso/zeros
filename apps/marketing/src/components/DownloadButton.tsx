import { DOWNLOAD_URL } from '../lib/site'

/**
 * Primary "Download for Mac" CTA. Uses the Zeros primary-button tokens
 * (fg1 fill on bg1 text) so it matches the Mac app's focal button.
 */
export function DownloadButton({
  size = 'lg',
  label = 'Download for Mac',
}: {
  size?: 'sm' | 'lg'
  label?: string
}) {
  const sizing =
    size === 'lg' ? 'px-5 py-2.5 text-[14px]' : 'px-3.5 py-1.5 text-[13px]'

  return (
    <a
      href={DOWNLOAD_URL}
      className={`inline-flex items-center justify-center rounded-full bg-primary-button-bg font-medium text-primary-button-fg transition-colors hover:bg-primary-button-hover ${sizing}`}
    >
      {label}
    </a>
  )
}
