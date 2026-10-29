import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import './css-animation.css'

export interface CssAnimationPlayerProps {
  /** Authoring canvas in CSS pixels. Children use this coordinate system. */
  width: number
  height: number
  /** Select CSS rules with [data-segment="name"]. */
  segment: string
  durationMs: number
  children: ReactNode
  playing?: boolean
  loop?: boolean
  fit?: 'cover' | 'contain'
  /** Defaults to the system preference. Static styles use [data-reduced="true"]. */
  reducedMotion?: boolean
  /** Change to restart the same segment. Pausing does not reset it. */
  playbackKey?: string | number
  className?: string
  style?: CSSProperties
  onComplete?: () => void
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

/**
 * HTML/WebP playback driven by native CSS keyframes. No BVA file, SVG bundle,
 * frame arrays, or JavaScript animation ticker. JavaScript only fits the canvas
 * on resize and forwards the CSS clock's completion event.
 */
export function CssAnimationPlayer({
  width, height, segment, durationMs, children, playing = true, loop = false,
  fit = 'cover', reducedMotion, playbackKey = 0, className = '', style, onComplete,
}: CssAnimationPlayerProps) {
  const systemReduced = useReducedMotion()
  const reduced = reducedMotion ?? systemReduced
  const container = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(0)
  const complete = useRef(onComplete)
  complete.current = onComplete
  const finished = useRef(false)
  const runKey = `${segment}:${playbackKey}:${durationMs}`

  useLayoutEffect(() => {
    const el = container.current
    if (!el) return
    const resize = () => {
      const x = el.clientWidth / width, y = el.clientHeight / height
      setScale(fit === 'cover' ? Math.max(x, y) : Math.min(x, y))
    }
    resize()
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    return () => observer.disconnect()
  }, [width, height, fit])

  useLayoutEffect(() => { finished.current = false }, [runKey])
  useEffect(() => {
    // Reduced motion must still complete finite segments. A loop remains a
    // static hold until the host selects its next segment.
    if (!reduced || !playing || loop || finished.current) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled || finished.current) return
      finished.current = true
      complete.current?.()
    })
    return () => { cancelled = true }
  }, [reduced, playing, loop, runKey])

  const variables = {
    ...style,
    '--bva-css-duration': `${Math.max(1, durationMs)}ms`,
    '--bva-css-state': playing ? 'running' : 'paused',
    '--bva-css-iterations': loop ? 'infinite' : '1',
  } as CSSProperties
  return <div ref={container} className={`bva-css-player ${className}`}
    style={variables} data-segment={segment} data-reduced={reduced} data-playing={playing}>
    <div className="bva-css-fit" style={{ width, height, visibility: scale > 0 ? 'visible' : 'hidden', transform: `translate(-50%, -50%) scale(${scale})` }}>
      <div key={runKey} className="bva-css-stage" onAnimationEnd={(event) => {
        if (event.target !== event.currentTarget || event.animationName !== 'bva-css-clock' || loop || finished.current) return
        finished.current = true
        complete.current?.()
      }}>{children}</div>
    </div>
  </div>
}

const imageLoads = new Map<string, Promise<void>>()
/** Decode only the selected external image; cache successful loads and retry failures. */
export function preloadCssImage(src: string): Promise<void> {
  let pending = imageLoads.get(src)
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const image = new Image()
      image.onload = () => {
        const decoded = typeof image.decode === 'function' ? image.decode() : Promise.resolve()
        decoded.then(() => resolve(), reject)
      }
      image.onerror = () => reject(new Error(`Unable to load animation image: ${src}`))
      image.src = src
    }).catch((error: unknown) => { imageLoads.delete(src); throw error })
    imageLoads.set(src, pending)
  }
  return pending
}
