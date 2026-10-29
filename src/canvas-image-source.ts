/**
 * CanvasImageSource
 *
 * Static image (SVG or bitmap) painted into a Canvas2D surface. SVG plates
 * are rasterized once at the rounded device size so `drawImage` does not
 * scale from the intrinsic viewBox every frame.
 */

import type { Matrix6 } from './baked-vector-animation'
import {
  mul6,
  type CanvasPaintPlacement,
  type CanvasPaintSource,
  type Rect,
} from './canvas-rig-painter'

const imageWaiters = new Set<() => void>()

export function subscribeCanvasImages(fn: () => void): () => void {
  imageWaiters.add(fn)
  return () => {
    imageWaiters.delete(fn)
  }
}

function notifyCanvasImages(): void {
  for (const fn of imageWaiters) fn()
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load ${src}`))
    img.src = src
  })
}

export class CanvasImageSource implements CanvasPaintSource {
  private path: string
  private size: { w: number; h: number }
  private image: HTMLImageElement | null = null
  private bitmap: { key: string; canvas: HTMLCanvasElement } | null = null
  private cancelled = false

  constructor(path: string, size: { w: number; h: number }) {
    this.path = path
    this.size = size
    void loadHtmlImage(path)
      .then((img) => {
        if (this.cancelled) return
        this.image = img
        notifyCanvasImages()
      })
      .catch(() => {
        if (this.cancelled) return
        notifyCanvasImages()
      })
  }

  contentBounds(): Rect | null {
    const { w, h } = this.size
    if (!(w > 0) || !(h > 0)) return null
    return { x: 0, y: 0, w, h }
  }

  poseKey(): string {
    return this.image ? `static|${this.path}` : `loading|${this.path}`
  }

  movedSince(key: string): boolean {
    return key !== this.poseKey()
  }

  paintInto(
    ctx: CanvasRenderingContext2D,
    surfaceToDevice: Matrix6,
    placement: CanvasPaintPlacement,
  ): boolean {
    const { w, h } = this.size
    if (!(w > 0) || !(h > 0)) return true
    const deviceW = Math.max(
      1,
      Math.round(w * placement.fit * placement.placementScale * placement.dpr),
    )
    const deviceH = Math.max(
      1,
      Math.round(h * placement.fit * placement.placementScale * placement.dpr),
    )
    const bmp = this.cachedBitmap(deviceW, deviceH)
    if (!bmp) return false
    const m = mul6(surfaceToDevice, placement.matrix)
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
    ctx.globalAlpha = 1
    ctx.drawImage(bmp, 0, 0, w, h)
    return true
  }

  clearCache(): void {
    this.bitmap = null
  }

  destroy(): void {
    this.cancelled = true
    this.image = null
    this.bitmap = null
  }

  private cachedBitmap(
    deviceW: number,
    deviceH: number,
  ): HTMLCanvasElement | null {
    const img = this.image
    if (!img) return null
    const key = `${deviceW}x${deviceH}`
    if (this.bitmap?.key === key) return this.bitmap.canvas
    const canvas = document.createElement('canvas')
    canvas.width = deviceW
    canvas.height = deviceH
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, deviceW, deviceH)
    this.bitmap = { key, canvas }
    return canvas
  }
}
