import { useEffect, useRef, useState } from 'react'

function readDpr(): number {
  if (typeof window === 'undefined') return 1
  const dpr = window.devicePixelRatio
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1
}

/**
 * Current device pixel ratio, tracked across zoom and monitor changes.
 *
 * A media query bound to the *current* ratio stops matching the moment it
 * changes, which is the only event browsers offer for this.
 */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(readDpr)

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`)
    const onChange = () => setDpr(readDpr())
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [dpr])

  return dpr
}

/**
 * Fit a fixed-size field into whatever space its wrapper has.
 *
 * The field owns this rather than its host because the scale is no longer only
 * a visual transform: it decides the device-pixel size every rig is rasterized
 * at, which drives both the culling tier and the motion epsilon.
 *
 * The first measurement is applied immediately, so the field is never painted
 * at the wrong size. Later ones are coalesced onto an animation frame: a tier
 * change re-resolves bundles and remounts parts, and mobile browsers stream
 * resize events continuously while the address bar collapses, so reacting to
 * every one of them would remount the crowd repeatedly during a scroll.
 */
export function useFitScale(size: { w: number; h: number } | null): {
  ref: React.RefObject<HTMLDivElement | null>
  fit: number
} {
  const ref = useRef<HTMLDivElement>(null)
  const [fit, setFit] = useState(1)
  const w = size?.w ?? 0
  const h = size?.h ?? 0

  useEffect(() => {
    const el = ref.current
    if (!el || w <= 0 || h <= 0) return

    let frame = 0
    let first = true
    const apply = (width: number, height: number) => {
      if (width === 0 || height === 0) return
      const next = Math.min(width / w, height / h)
      if (next > 0) setFit(next)
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (first) {
        first = false
        apply(width, height)
        return
      }
      if (frame !== 0) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = 0
        apply(width, height)
      })
    })
    observer.observe(el)

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [w, h])

  return { ref, fit }
}
