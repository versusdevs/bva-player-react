/**
 * RasteredRigPainter
 *
 * One ticking rig, many HTML instances. Each animatable part is a WebP
 * `<img>` whose pose is a CSS `transform`. The per-frame matrix string is
 * built once and fanned out, so N copies share one ticker and stay on the
 * compositor as long as the layer budget allows.
 */

import {
  pickRasterScale,
  visibilityQuantizers,
  type AssetBundle,
  type AssetPart,
  type Matrix6,
  type MotionData,
  type Quantizers,
  type RasterBundle,
  type RasterPart,
} from './baked-vector-animation'
import { cullScaleFor, motionPartScales, motionStageScale } from './gamefield/cullTier'
import { DEFAULT_RASTERED_LAYER_BUDGET } from './gamefield/types'

export { DEFAULT_RASTERED_LAYER_BUDGET }

export interface RasterInstancePlacement {
  /**
   * Device pixels one canvas unit covers for this copy (fit × dpr × scale).
   * Quantized internally so a resize drag does not churn `src`.
   */
  pxPerCanvasUnit: number
}

export interface RasterInstanceHandle {
  readonly id: number
}

interface PainterPart {
  name: string
  raster: RasterPart
  matrices: Matrix6[]
  opacities?: number[]
  last: Matrix6 | null
  lastOpacity: number | null
  lastTransform: string
  localRadius: number
  qT: number
  qL: number
}

interface RigInstance {
  id: number
  container: HTMLElement
  stageEl: HTMLDivElement
  imgs: HTMLImageElement[]
  pxPerCanvasUnit: number
}

const WILL_CHANGE_TRANSFORM = 'transform'
// Opacity must be named here. `will-change: transform` alone does not pin an
// effect node, so an o0 toggle still creates/destroys one and forces a full
// document layerization. `opacity: 1` on the style is not enough — Blink
// treats identity opacity as no effect unless will-change asks for it.
const WILL_CHANGE_PART = 'transform, opacity'

let nextInstanceId = 1
const painters = new Set<RasteredRigPainter>()
let promoteParts = true

function rasterLocalRadius(rect: { x: number; y: number; w: number; h: number }): number {
  const x2 = rect.x + rect.w
  const y2 = rect.y + rect.h
  return Math.max(
    Math.hypot(rect.x, rect.y),
    Math.hypot(x2, rect.y),
    Math.hypot(rect.x, y2),
    Math.hypot(x2, y2),
  )
}

function matrixCss(m: Matrix6): string {
  return `matrix(${m[0]},${m[1]},${m[2]},${m[3]},${m[4]},${m[5]})`
}

function partTransform(m: Matrix6, rect: { x: number; y: number }): string {
  return `${matrixCss(m)} translate(${rect.x}px,${rect.y}px)`
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

function partOpacityAt(
  part: { opacities?: number[] },
  frame: number,
): number {
  return part.opacities?.[frame] ?? part.opacities?.[part.opacities.length - 1] ?? 1
}

function totalRasteredParts(): number {
  let n = 0
  for (const painter of painters) n += painter.partCount() * painter.instanceCount()
  return n
}

function applyLayerBudget(): void {
  const next = totalRasteredParts() <= DEFAULT_RASTERED_LAYER_BUDGET
  if (next === promoteParts) return
  promoteParts = next
  for (const painter of painters) painter.syncWillChange()
}

function loadHtmlImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to draw ${src}`))
    img.src = src
  })
}

function opaquePixelBounds(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] === 0) continue
    const x = i % width
    const y = (i - x) / width
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (maxX < 0) return null
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }
}

function parseViewBox(vb: string): { x: number; y: number; w: number; h: number } {
  const [x, y, w, h] = String(vb ?? '0 0 0 0')
    .trim()
    .split(/[\s,]+/)
    .map(Number)
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
    w: Number.isFinite(w) ? w : 0,
    h: Number.isFinite(h) ? h : 0,
  }
}

/**
 * Rasterize one resolved vector part (variables already substituted) so
 * face/hair match the SVG player instead of the bake-time default clip.
 *
 * The layer viewBox is often a huge empty artboard (2160²) with `width: 0`.
 * Drawing that at 1:1 blows the canvas and can fail on phones; cap the
 * raster so crop math still maps back to viewBox units.
 */
const VARIABLE_RASTER_MAX_PX = 512

export async function rasterizeSvgPart(
  part: AssetPart,
  opts?: { unit?: number; density?: number },
): Promise<RasterPart | null> {
  if (typeof document === 'undefined' || !part.body) return null
  const vb = parseViewBox(part.viewBox)
  if (!(vb.w > 0) || !(vb.h > 0)) return null
  const nativeW = part.width > 0 ? part.width : vb.w
  const nativeH = part.height > 0 ? part.height : vb.h
  const unit = opts?.unit && opts.unit > 0 ? opts.unit : 1
  const density = opts?.density && opts.density > 0 ? opts.density : 1
  const pxPerLocal = unit * density
  let width = Math.max(1, Math.round(nativeW * pxPerLocal))
  let height = Math.max(1, Math.round(nativeH * pxPerLocal))
  const longest = Math.max(width, height)
  if (longest > VARIABLE_RASTER_MAX_PX) {
    const s = VARIABLE_RASTER_MAX_PX / longest
    width = Math.max(1, Math.round(width * s))
    height = Math.max(1, Math.round(height * s))
  }
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${part.viewBox}" ` +
    `width="${width}" height="${height}">${part.body}</svg>`
  const objectUrl = URL.createObjectURL(
    new Blob([svg], { type: 'image/svg+xml' }),
  )
  try {
    const img = await loadHtmlImage(objectUrl)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width))
    canvas.height = Math.max(1, Math.round(height))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const crop = opaquePixelBounds(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
      canvas.width,
      canvas.height,
    )
    if (!crop) return null
    const out = document.createElement('canvas')
    out.width = crop.w
    out.height = crop.h
    out.getContext('2d')?.drawImage(
      canvas,
      crop.x,
      crop.y,
      crop.w,
      crop.h,
      0,
      0,
      crop.w,
      crop.h,
    )
    const src = out.toDataURL('image/png')
    const rect = {
      x: vb.x + (crop.x / canvas.width) * vb.w,
      y: vb.y + (crop.y / canvas.height) * vb.h,
      w: (crop.w / canvas.width) * vb.w,
      h: (crop.h / canvas.height) * vb.h,
    }
    return { rect, unit, srcFor: () => src }
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

/**
 * Replace bake-time WebPs for parts whose look is resolved at play time
 * (host-supplied names such as Face / Hairstyle).
 */
export async function overlayVariableRasters(
  rasters: RasterBundle,
  bundle: AssetBundle,
  variableParts?: readonly string[],
): Promise<RasterBundle> {
  if (!variableParts?.length) return rasters
  const parts = { ...rasters.parts }
  await Promise.all(
    variableParts.map(async (name) => {
      const part = bundle.parts[name]
      if (!part) return
      const baked = await rasterizeSvgPart(part, {
        unit: rasters.parts[name]?.unit ?? rasters.units[name] ?? 1,
        density: 3,
      })
      if (baked) parts[name] = baked
    }),
  )
  return { ...rasters, parts }
}

/**
 * Pick a bake density (1 / 2 / 3) for one part.
 *
 * `unit` is 1x pixels per local viewBox unit. New sidecars store the posed
 * CSS size there, so this reduces to `fit × dpr × placement`. Legacy
 * sidecars omit `unit` (treated as 1) and keep the old
 * `px × stage × part` request, which still picks 1x on the field.
 */
export function rasterScaleForPart(
  scales: number[],
  pxPerCanvasUnit: number,
  stageScale: number,
  partScale: number,
  unit = 1,
): number {
  const quantized = cullScaleFor(pxPerCanvasUnit)
  const perLocalUnit = quantized * stageScale * (partScale > 0 ? partScale : 1)
  const requested = unit > 0 ? perLocalUnit / unit : perLocalUnit
  return pickRasterScale(scales, requested)
}

export class RasteredRigPainter {
  private motion: MotionData
  private rasters: RasterBundle
  private parts: PainterPart[] = []
  private instances: RigInstance[] = []
  private currentSegment: string
  private currentFrame = 0
  private visibilityPxPerCanvasUnit = 0
  private visibilityThresholdPx = 1
  private partScales: Record<string, number>
  private stageScale: number

  constructor(motion: MotionData, rasters: RasterBundle) {
    this.motion = motion
    this.rasters = rasters
    this.partScales = motionPartScales(motion)
    this.stageScale = motionStageScale(motion)
    this.currentSegment = Object.keys(motion.segments)[0] ?? ''
    this.rebuildParts()
    this.applyFrame()
    painters.add(this)
  }

  addInstance(
    container: HTMLElement,
    placement: RasterInstancePlacement,
  ): RasterInstanceHandle {
    const stageEl = document.createElement('div')
    stageEl.className = 'gamefield-raster-stage'
    stageEl.style.width = `${this.motion.canvas.w}px`
    stageEl.style.height = `${this.motion.canvas.h}px`
    stageEl.style.transform = matrixCss(this.motion.stage)
    container.appendChild(stageEl)
    const instance: RigInstance = {
      id: nextInstanceId++,
      container,
      stageEl,
      imgs: [],
      pxPerCanvasUnit: placement.pxPerCanvasUnit,
    }
    this.instances.push(instance)
    this.mountInstance(instance)
    this.applyFrame()
    applyLayerBudget()
    return { id: instance.id }
  }

  removeInstance(handle: RasterInstanceHandle): void {
    const idx = this.instances.findIndex((inst) => inst.id === handle.id)
    if (idx < 0) return
    const inst = this.instances[idx]
    inst.stageEl.remove()
    this.instances.splice(idx, 1)
    applyLayerBudget()
  }

  setSegment(name: string): void {
    if (!this.motion.segments[name] || this.currentSegment === name) return
    this.currentSegment = name
    this.currentFrame = 0
    this.rebuildParts()
    this.remountAll()
    this.applyFrame()
  }

  gotoFrame(f: number): void {
    const seg = this.motion.segments[this.currentSegment]
    if (!seg) return
    this.currentFrame = Math.max(0, Math.min(seg.frames - 1, f | 0))
    this.applyFrame()
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
    this.applyFrame()
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

  instanceCount(): number {
    return this.instances.length
  }

  getShapeCounts(): { mounted: number; culled: number } {
    return { mounted: this.parts.length, culled: 0 }
  }

  syncWillChange(): void {
    for (const inst of this.instances) {
      inst.container.style.willChange = promoteParts ? '' : WILL_CHANGE_TRANSFORM
      for (const img of inst.imgs) {
        img.style.willChange = promoteParts ? WILL_CHANGE_PART : ''
      }
    }
  }

  destroy(): void {
    for (const inst of this.instances) inst.stageEl.remove()
    this.instances = []
    this.parts = []
    painters.delete(this)
    applyLayerBudget()
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
        last: null,
        lastOpacity: null,
        lastTransform: '',
        localRadius: rasterLocalRadius(raster.rect),
        qT: q.qT,
        qL: q.qL,
      })
    }
  }

  private remountAll(): void {
    for (const inst of this.instances) this.mountInstance(inst)
    applyLayerBudget()
  }

  private mountInstance(inst: RigInstance): void {
    inst.stageEl.replaceChildren()
    inst.imgs = []
    for (const part of this.parts) {
      const img = document.createElement('img')
      img.className = 'gamefield-raster-part'
      img.alt = ''
      img.draggable = false
      img.decoding = 'async'
      img.width = part.raster.rect.w
      img.height = part.raster.rect.h
      img.style.width = `${part.raster.rect.w}px`
      img.style.height = `${part.raster.rect.h}px`
      img.style.transformOrigin = '0 0'
      img.src = part.raster.srcFor(
        rasterScaleForPart(
          this.rasters.scales,
          inst.pxPerCanvasUnit,
          this.stageScale,
          this.partScales[part.name] ?? 1,
          part.raster.unit,
        ),
      )
      const pose =
        part.lastTransform ||
        partTransform(
          part.matrices[this.currentFrame] ??
            part.matrices[part.matrices.length - 1],
          part.raster.rect,
        )
      img.style.transform = pose
      // Keep opacity on the element even at 1. Clearing it destroys the
      // effect node; the next o0 toggle recreates it and forces a full
      // document layerization.
      img.style.opacity = String(partOpacityAt(part, this.currentFrame))
      img.addEventListener('error', () => {
        img.style.visibility = 'hidden'
      })
      img.style.willChange = promoteParts ? WILL_CHANGE_PART : ''
      inst.stageEl.appendChild(img)
      inst.imgs.push(img)
    }
    inst.container.style.willChange = promoteParts ? '' : WILL_CHANGE_TRANSFORM
  }

  private refreshQuantizers(): void {
    for (const part of this.parts) {
      const q = this.quantizersFor(part.localRadius)
      part.qT = q.qT
      part.qL = q.qL
      part.last = null
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

  private applyFrame(): void {
    const idx = this.currentFrame
    for (let p = 0; p < this.parts.length; p++) {
      const part = this.parts[p]
      const m = part.matrices[idx] ?? part.matrices[part.matrices.length - 1]
      const opacity = partOpacityAt(part, idx)
      const matrixSame = sameQuantized(m, part.last, part.qT, part.qL)
      const ro = roundOpacity(opacity)
      const opacitySame = part.lastOpacity !== null && part.lastOpacity === ro
      if (matrixSame && opacitySame) continue

      if (!matrixSame) {
        const t = partTransform(m, part.raster.rect)
        part.lastTransform = t
        part.last = writeQuantized(m, part.qT, part.qL)
        for (const inst of this.instances) {
          const img = inst.imgs[p]
          if (img) img.style.transform = t
        }
      }
      if (!opacitySame) {
        part.lastOpacity = ro
        const value = String(opacity)
        for (const inst of this.instances) {
          const img = inst.imgs[p]
          if (img) img.style.opacity = value
        }
      }
    }
  }
}

/** @deprecated Use {@link RasteredRigPainter}. */
export const RasteredCrowd = RasteredRigPainter
