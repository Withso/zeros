import { useEffect, useRef } from 'react'
import { paintHeroAsciiField } from '../lib/hero-ascii-field'
import './hero-ascii-clouds.css'

/**
 * Full-bleed ASCII atmosphere behind the homepage hero. Paints once per
 * size (and when Geist Mono loads); slow CSS drift is gated off under
 * prefers-reduced-motion.
 */
export function HeroAsciiClouds() {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    const canvas = canvasRef.current
    if (!wrap || !canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let cancelled = false
    let frame = 0

    const paint = () => {
      if (cancelled) return
      const cssW = wrap.clientWidth
      const cssH = wrap.clientHeight
      if (cssW < 8 || cssH < 8) return
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const overscan = 1.12
      const drawW = cssW * overscan
      const drawH = cssH * overscan
      canvas.width = Math.round(drawW * dpr)
      canvas.height = Math.round(drawH * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      paintHeroAsciiField(ctx, drawW, drawH)
    }

    const schedule = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(paint)
    }

    schedule()
    const fonts = document.fonts
    void fonts?.load('8px "Geist Mono"').then(() => {
      if (!cancelled) schedule()
    })
    fonts?.addEventListener('loadingdone', schedule)

    const observer = new ResizeObserver(schedule)
    observer.observe(wrap)
    window.addEventListener('resize', schedule)

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      fonts?.removeEventListener('loadingdone', schedule)
    }
  }, [])

  return (
    <div
      ref={wrapRef}
      className="hero-ascii-clouds"
      aria-hidden
      data-hero-ascii-clouds=""
    >
      <div className="hero-ascii-atmosphere" />
      <canvas ref={canvasRef} className="hero-ascii-clouds-canvas" />
    </div>
  )
}
