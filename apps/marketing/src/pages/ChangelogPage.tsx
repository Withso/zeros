import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'
import { getChangelogEntries } from '../lib/changelog'

// Prose styling via arbitrary variants (no typography plugin needed). Tuned to
// the Zeros Dark Theme tokens — fg1 for emphasis, fg2 for body, fg3 for faint.
const PROSE =
  'text-[14px] leading-[1.7] text-fg2 ' +
  '[&_h2]:mt-7 [&_h2]:mb-3 [&_h2]:text-[15px] [&_h2]:font-medium [&_h2]:text-fg1 ' +
  '[&_h3]:mt-5 [&_h3]:mb-2 [&_h3]:text-[14px] [&_h3]:font-medium [&_h3]:text-fg1 ' +
  '[&_p]:my-3 ' +
  '[&_strong]:font-medium [&_strong]:text-fg1 ' +
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:pl-5 [&_li]:my-1 [&_li]:marker:text-fg3 ' +
  '[&_a]:text-fg1 [&_a]:underline [&_a]:underline-offset-2 [&_a:hover]:text-fg2 ' +
  '[&_code]:rounded [&_code]:bg-bg3 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-fg1 ' +
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-border1 [&_pre]:bg-bg1 [&_pre]:p-4 [&_pre]:text-[12.5px] ' +
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 ' +
  '[&_img]:my-4 [&_img]:rounded-lg [&_img]:border [&_img]:border-border1 ' +
  '[&_video]:my-4 [&_video]:w-full [&_video]:rounded-lg [&_video]:border [&_video]:border-border1 ' +
  '[&_details]:my-4 [&_details]:rounded-lg [&_details]:border [&_details]:border-border1 [&_details]:bg-bg2 [&_details]:px-4 [&_details]:py-3 ' +
  '[&_summary]:cursor-pointer [&_summary]:text-[13px] [&_summary]:text-fg2'

export function ChangelogPage() {
  const entries = getChangelogEntries()

  return (
    <div className="relative flex min-h-screen flex-col">
      <Nav />

      <main className="mx-auto w-full max-w-[760px] flex-1 px-5 pt-14 pb-24 sm:px-8 sm:pt-20">
        <h1 className="text-[28px] font-medium tracking-[-0.02em] text-fg1 sm:text-[34px]">
          Changelog
        </h1>
        <p className="mt-3 text-[14px] text-fg3">What&apos;s new in Zeros.</p>

        {entries.length === 0 ? (
          <p className="mt-16 text-[14px] text-fg3">
            No releases yet — check back soon.
          </p>
        ) : (
          <div className="mt-12 flex flex-col">
            {entries.map((entry) => (
              <article
                key={entry.version}
                className="border-t border-border1 py-10 first:border-t-0 first:pt-0"
              >
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center rounded-full border border-border3 bg-bg2 px-2.5 py-0.5 text-[12px] font-medium tracking-tight text-fg1">
                    v{entry.version}
                  </span>
                  {entry.date && (
                    <time className="text-[12.5px] text-fg3" dateTime={entry.date}>
                      {formatDate(entry.date)}
                    </time>
                  )}
                </div>

                <h2 className="mt-4 text-[20px] font-medium tracking-[-0.015em] text-fg1">
                  {entry.title}
                </h2>
                {entry.summary && (
                  <p className="mt-2 text-[14px] leading-[1.6] text-fg2">
                    {entry.summary}
                  </p>
                )}

                {entry.body && (
                  <div className={`mt-5 ${PROSE}`}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
                      {entry.body}
                    </ReactMarkdown>
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </main>

      <Footer />
    </div>
  )
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
