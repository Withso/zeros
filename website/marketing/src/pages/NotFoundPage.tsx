import { Link } from 'react-router-dom'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'

/** Client-side 404 (catch-all route). Server-side unknown paths are answered
 *  by the static 404.html in website/web-app/public — this page only shows for
 *  in-app navigations or SPA-fallback paths that have no matching route. */
export function NotFoundPage() {
  return (
    <div className="relative flex min-h-screen flex-col">
      <Nav />

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col items-center justify-center px-5 py-24 text-center sm:px-8">
        <p className="text-[13px] tracking-[0.08em] text-fg3">404</p>
        <h1 className="mt-2 text-[28px] font-medium tracking-[-0.02em] text-fg1 sm:text-[34px]">
          Page not found
        </h1>
        <p className="mt-3 text-[14px] text-fg3">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center justify-center rounded-full bg-primary-button-bg px-5 py-2.5 text-[14px] font-medium text-primary-button-fg transition-colors hover:bg-primary-button-hover"
        >
          Go home
        </Link>
      </main>

      <Footer />
    </div>
  )
}
