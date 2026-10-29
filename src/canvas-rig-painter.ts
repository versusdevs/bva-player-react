/**
 * CanvasRigPainter
 *
 * One ticking pose source, no DOM. A canvas surface paints every placement
 * by folding the CSS transform chain into one affine and issuing
 * `setTransform` + `drawImage` per part (or one blit per instance when the
 * offscreen pose cache is on).
 */

import {
  visibilityQuantizers,
  type Matrix6,
  type MotionData,
  type Quantizers,
  type RasterBundle,
  type RasterPart,
} from './baked-vector-animation'
import { motionPartScales, motionStageScale } from './gamefield/cullTier'
import { rasterScaleForPart } from './rastered-rig-painter'
import type { SmartBvaPlacement } from './gamefield/types'

export type Rect = { x: number; y: number; w: number; h: number }

interface PainterPart {
  name: string
  raster: RasterPart
  matrices: Matrix6[]
  opacities?: number[]
  localRadius: number
  qT: number
  qL: number
}

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0]

/** @deprecated Field-wide fallback; prefer `CanvasPaintPlacement.poseCache`. */
let poseCacheDefault = false

/** @deprecated Surfaces pass `poseCache` per paint. Kept for older hosts. */
export function setCanvasPoseCache(enabled: boolean): void {
  poseCacheDefault = !!enabled
}

/** @deprecated Use `CanvasPaintPlacement.poseCache`. */
export function isCanvasPoseCacheEnabled(): boolean {
  return poseCacheDefault
}

/** @deprecated Use {@link setCanvasPoseCache}. */
export const setCanvasCrowdCache = setCanvasPoseCache
/** @deprecated Use {@link isCanvasPoseCacheEnabled}. */
export const isCanvasCrowdCacheEnabled = isCanvasPoseCacheEnabled

const rasterImages = new Map<string, HTMLImageElement>()
const rasterImageWaiters = new Set<() => void>()

export function subscribeRasterImages(fn: () => void): () => void {
  rasterImageWaiters.add(fn)
  return () => {
    rasterImageWaiters.delete(fn)
  }
}

function notifyRasterImages(): void {
  for (const fn of rasterImageWaiters) fn()
}

function rasterImageFor(src: string): HTMLImageElement | null {
  let img = rasterImages.get(src)
  if (img) return img.complete && img.naturalWidth > 0 ? img : null
  img = new Image()
  img.decoding = 'async'
  img.src = src
  rasterImages.set(src, img)
  const done = () => notifyRasterImages()
  if (typeof img.decode === 'function') {
    void img.decode().then(done, done)
  } else {
    img.onload = done
    img.onerror = done
  }
  return null
}

function rasterLocalRadius(rect: Rect): number {
  const x2 = rect.x + rect.w
  const y2 = rect.y + rect.h
  return Math.max(
    Math.hypot(rect.x, rect.y),
    Math.hypot(x2, rect.y),
    Math.hypot(rect.x, y2),
    Math.hypot(x2, y2),
  )
}

export function mul6(a: Matrix6, b: Matrix6): Matrix6 {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

export function translate6(tx: number, ty: number): Matrix6 {
  return [1, 0, 0, 1, tx, ty]
}

export function scale6(sx: number, sy: number): Matrix6 {
  return [sx, 0, 0, sy, 0, 0]
}

export function apply6(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function setTransform6(
  ctx: CanvasRenderingContext2D,
  m: Matrix6,
): void {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5])
}

function sameQuantized(
  m: Matrix6,
  last: Matrix6 | null,
  qT: number,
  qL: number,
): boolean {
  if (!last) return false
  return (
    last[0] === Math.round(m[0] * qL) &&
    last[1] === Math.round(m[1] * qL) &&
    last[2] === Math.round(m[2] * qL) &&
    last[3] === Math.round(m[3] * qL) &&
    last[4] === Math.round(m[4] * qT) &&
    last[5] === Math.round(m[5] * qT)
  )
}

function writeQuantized(m: Matrix6, qT: number, qL: number): Matrix6 {
  return [
    Math.round(m[0] * qL),
    Math.round(m[1] * qL),
    Math.round(m[2] * qL),
    Math.round(m[3] * qL),
    Math.round(m[4] * qT),
    Math.round(m[5] * qT),
  ]
}

function roundOpacity(o: number): number {
  return Math.round(o * 100)
}

function opacityAt(part: PainterPart, idx: number): number {
  return (
    part.opacities?.[idx] ?? part.opacities?.[part.opacities.length - 1] ?? 1
  )
}

function matrixAt(part: PainterPart, idx: number): Matrix6 {
  return part.matrices[idx] ?? part.matrices[part.matrices.length - 1]
}

export function transformRect(m: Matrix6, rect: Rect): Rect {
  const x2 = rect.x + rect.w
  const y2 = rect.y + rect.h
  const p0 = apply6(m, rect.x, rect.y)
  const p1 = apply6(m, x2, rect.y)
  const p2 = apply6(m, rect.x, y2)
  const p3 = apply6(m, x2, y2)
  const minX = Math.min(p0[0], p1[0], p2[0], p3[0])
  const minY = Math.min(p0[1], p1[1], p2[1], p3[1])
  const maxX = Math.max(p0[0], p1[0], p2[0], p3[0])
  const maxY = Math.max(p0[1], p1[1], p2[1], p3[1])
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function unionRects(rects: Rect[]): Rect | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rects) {
    if (!(r.w > 0) || !(r.h > 0)) continue
    if (r.x < minX) minX = r.x
    if (r.y < minY) minY = r.y
    if (r.x + r.w > maxX) maxX = r.x + r.w
    if (r.y + r.h > maxY) maxY = r.y + r.h
  }
  if (!Number.isFinite(minX)) return null
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  )
}

export function rectArea(rect: Rect): number {
  return rect.w > 0 && rect.h > 0 ? rect.w * rect.h : 0
}

/**
 * CSS-stage matrix matching RasteredSmartBvaDraw:
 * `translate(pos·fit) scale(sx·fit, s·fit) translate(-canvas/2)`.
 */
export function placementDrawMatrix(
  placement: SmartBvaPlacement,
  canvas: { w: number; h: number },
  fit: number,
  baseScale: number,
): Matrix6 {
  const scale = (placement.scale ?? 1) * baseScale
  const sx = placement.mirror ? -scale : scale
  return mul6(
    translate6(placement.position[0] * fit, placement.position[1] * fit),
    mul6(
      scale6(sx * fit, scale * fit),
      translate6(-canvas.w / 2, -canvas.h / 2),
    ),
  )
}

export interface CanvasPaintPlacement {
  /** CSS-stage placement matrix. */
  matrix: Matrix6
  /** Device pixels per canvas unit for this copy (fit × dpr × placement scale). */
  pxPerCanvasUnit: number
  placementScale: number
  fit: number
  dpr: number
  /** Paint the pose once into an offscreen bitmap and blit copies. */
  poseCache?: boolean
}

export interface CanvasPaintSource {
  contentBounds(): Rect | null
  poseKey(): string
  movedSince(key: string): boolean
  paintInto(
    ctx: CanvasRenderingContext2D,
    surfaceToDevice: Matrix6,
    placement: CanvasPaintPlacement,
  ): boolean
  clearCache(): void
}

export class CanvasRigPainter implements CanvasPaintSource {
  private motion: MotionData
  private rasters: RasterBundle
  private parts: PainterPart[] = []
  private currentSegment: string
  private currentFrame = 0
  private visibilityPxPerCanvasUnit = 0
  private visibilityThresholdPx = 1
  private partScales: Record<string, number>
  private stageScale: number
  private cache: { key: string; canvas: HTMLCanvasElement } | null = null
  private boundsBySegment = new Map<string, Rect | null>()

  constructor(motion: MotionData, rasters: RasterBundle) {
    this.motion = motion
    this.rasters = rasters
    this.partScales = motionPartScales(motion)
    this.stageScale = motionStageScale(motion)
    this.currentSegment = Object.keys(motion.segments)[0] ?? ''
    this.rebuildParts()
  }

  setSegment(name: string): void {
    if (!this.motion.segments[name] || this.currentSegment === name) return
    this.currentSegment = name
    this.currentFrame = 0
    this.rebuildParts()
    this.cache = null
    this.boundsBySegment.delete(name)
  }

  gotoFrame(f: number): void {
    const seg = this.motion.segments[this.currentSegment]
    if (!seg) return
    this.currentFrame = Math.max(0, Math.min(seg.frames - 1, f | 0))
  }

  setVisibilityScale(devicePxPerCanvasUnit: number, thresholdPx = 1): void {
    const px =
      Number.isFinite(devicePxPerCanvasUnit) && devicePxPerCanvasUnit > 0
        ? devicePxPerCanvasUnit
        : 0
    const threshold =
      Number.isFinite(thresholdPx) && thresholdPx > 0 ? thresholdPx : 1
    if (
      px === this.visibilityPxPerCanvasUnit &&
      threshold === this.visibilityThresholdPx
    ) {
      return
    }
    this.visibilityPxPerCanvasUnit = px
    this.visibilityThresholdPx = threshold
    this.refreshQuantizers()
  }

  getSegment(): string {
    return this.currentSegment
  }

  getFrame(): number {
    return this.currentFrame
  }

  getSegmentFrames(): number {
    return this.motion.segments[this.currentSegment]?.frames ?? 0
  }

  getCanvas(): { w: number; h: number } {
    return this.motion.canvas
  }

  partCount(): number {
    return this.parts.length
  }

  getShapeCounts(): { mounted: number; culled: number } {
    return { mounted: this.parts.length, culled: 0 }
  }

  poseKey(): string {
    return `${this.currentSegment}|${this.currentFrame}`
  }

  /**
   * Union of every part rect, after the stage matrix, across every frame of
   * the current segment. Motion-canvas units. Cached per segment object.
   */
  contentBounds(): Rect | null {
    const seg = this.motion.segments[this.currentSegment]
    if (!seg) return null
    if (this.boundsBySegment.has(this.currentSegment)) {
      return this.boundsBySegment.get(this.currentSegment) ?? null
    }
    const rects: Rect[] = []
    const frames = seg.frames
    const stage = this.motion.stage
    for (const part of this.parts) {
      const { rect } = part.raster
      for (let f = 0; f < frames; f++) {
        const m = mul6(stage, mul6(matrixAt(part, f), translate6(rect.x, rect.y)))
        rects.push(transformRect(m, { x: 0, y: 0, w: rect.w, h: rect.h }))
      }
    }
    const bounds = unionRects(rects)
    this.boundsBySegment.set(this.currentSegment, bounds)
    return bounds
  }

  movedSince(key: string): boolean {
    if (key === this.poseKey()) return false
    const pipe = key.lastIndexOf('|')
    if (pipe < 0) return true
    const segment = key.slice(0, pipe)
    const frame = Number(key.slice(pipe + 1))
    if (segment !== this.currentSegment || !Number.isFinite(frame)) return true
    return this.movedSinceFrame(frame)
  }

  /** True if any part's quantized pose differs from `otherFrame`. */
  movedSinceFrame(otherFrame: number): boolean {
    if (otherFrame === this.currentFrame) return false
    const idx = this.currentFrame
    for (const part of this.parts) {
      const a = matrixAt(part, otherFrame)
      const b = matrixAt(part, idx)
      if (!sameQuantized(b, writeQuantized(a, part.qT, part.qL), part.qT, part.qL)) {
        return true
      }
      if (roundOpacity(opacityAt(part, otherFrame)) !== roundOpacity(opacityAt(part, idx))) {
        return true
      }
    }
    return false
  }

  /**
   * Paint this pose into `ctx`. `surfaceToDevice` maps CSS-stage pixels onto
   * the surface backing store (`S(dpr) · T(-surfaceCssOrigin)`).
   */
  paintInto(
    ctx: CanvasRenderingContext2D,
    surfaceToDevice: Matrix6,
    placement: CanvasPaintPlacement,
  ): boolean {
    const useCache = placement.poseCache ?? poseCacheDefault
    if (useCache) {
      return this.paintCached(ctx, surfaceToDevice, placement)
    }
    const world = mul6(surfaceToDevice, placement.matrix)
    return this.paintParts(ctx, world, placement.pxPerCanvasUnit)
  }

  clearCache(): void {
    this.cache = null
  }

  destroy(): void {
    this.parts = []
    this.cache = null
  }

  private paintCached(
    ctx: CanvasRenderingContext2D,
    surfaceToDevice: Matrix6,
    placement: CanvasPaintPlacement,
  ): boolean {
    const bounds = this.contentBounds()
    if (!bounds) return true
    const pixelScale = placement.dpr * placement.placementScale * placement.fit
    if (!(pixelScale > 0)) return true
    const bmp = this.cachedBitmap(pixelScale, placement.pxPerCanvasUnit)
    if (!bmp) return false
    const blit = mul6(
      surfaceToDevice,
      mul6(
        placement.matrix,
        mul6(translate6(bounds.x, bounds.y), scale6(1 / pixelScale, 1 / pixelScale)),
      ),
    )
    setTransform6(ctx, blit)
    ctx.globalAlpha = 1
    ctx.drawImage(bmp, 0, 0)
    return true
  }

  private cachedBitmap(
    pixelScale: number,
    pxPerCanvasUnit: number,
  ): HTMLCanvasElement | null {
    const bounds = this.contentBounds()
    if (!bounds) return null
    const key = `${this.currentSegment}|${this.currentFrame}|${pixelScale.toFixed(4)}`
    if (this.cache?.key === key) return this.cache.canvas
    const w = Math.max(1, Math.ceil(bounds.w * pixelScale))
    const h = Math.max(1, Math.ceil(bounds.h * pixelScale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const prefix = mul6(scale6(pixelScale, pixelScale), translate6(-bounds.x, -bounds.y))
    const ready = this.paintParts(ctx, prefix, pxPerCanvasUnit)
    if (!ready) return null
    this.cache = { key, canvas }
    return canvas
  }

  private paintParts(
    ctx: CanvasRenderingContext2D,
    prefix: Matrix6,
    pxPerCanvasUnit: number,
  ): boolean {
    const idx = this.currentFrame
    const stage = this.motion.stage
    let ready = true
    for (const part of this.parts) {
      const opacity = opacityAt(part, idx)
      if (opacity <= 0) continue
      const scale = rasterScaleForPart(
        this.rasters.scales,
        pxPerCanvasUnit,
        this.stageScale,
        this.partScales[part.name] ?? 1,
        part.raster.unit,
      )
      const img = rasterImageFor(part.raster.srcFor(scale))
      if (!img) {
        ready = false
        continue
      }
      const { rect } = part.raster
      const m = mul6(
        prefix,
        mul6(stage, mul6(matrixAt(part, idx), translate6(rect.x, rect.y))),
      )
      setTransform6(ctx, m)
      ctx.globalAlpha = opacity
      ctx.drawImage(img, 0, 0, rect.w, rect.h)
    }
    ctx.globalAlpha = 1
    ctx.setTransform(IDENTITY[0], IDENTITY[1], IDENTITY[2], IDENTITY[3], IDENTITY[4], IDENTITY[5])
    return ready
  }

  private rebuildParts(): void {
    this.parts = []
    const seg = this.motion.segments[this.currentSegment]
    if (!seg) return
    for (const part of seg.parts) {
      if (part.fills || part.strokes) continue
      const raster = this.rasters.parts[part.asset]
      if (!raster) continue
      const q = this.quantizersFor(rasterLocalRadius(raster.rect))
      this.parts.push({
        name: part.asset,
        raster,
        matrices: part.matrices,
        opacities: part.opacities,
        localRadius: rasterLocalRadius(raster.rect),
        qT: q.qT,
        qL: q.qL,
      })
    }
  }

  private refreshQuantizers(): void {
    for (const part of this.parts) {
      const q = this.quantizersFor(part.localRadius)
      part.qT = q.qT
      part.qL = q.qL
    }
  }

  private quantizersFor(localRadius: number): Quantizers {
    return visibilityQuantizers(
      this.motion.stage,
      this.visibilityPxPerCanvasUnit,
      this.visibilityThresholdPx,
      localRadius,
    )
  }
}

/** @deprecated Use {@link CanvasRigPainter}. */
export const CanvasCrowd = CanvasRigPainter
