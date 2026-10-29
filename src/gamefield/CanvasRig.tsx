import { useEffect, useMemo, useRef, useState } from 'react'
import {
  loadAssetBundle,
  loadMotion,
  loadRasterBundle,
  prefetchAssetBundle,
  resolveSegmentName,
  type MotionData,
  type RasterBundle,
} from '../baked-vector-animation'
import { CanvasImageSource, subscribeCanvasImages } from '../canvas-image-source'
import {
  CanvasRigPainter,
  mul6,
  placementDrawMatrix,
  rectArea,
  rectsIntersect,
  scale6,
  subscribeRasterImages,
  transformRect,
  translate6,
  unionRects,
  type CanvasPaintSource,
  type Rect,
} from '../canvas-rig-painter'
import { overlayVariableRasters } from '../rastered-rig-painter'
import {
  markQualityRigReady,
  recordPoseSkip,
  registerQualityRig,
  skipNForPriority,
  unregisterQualityRig,
} from './fieldQuality'
import {
  recordRigShapes,
  releaseRigShapes,
  subscribeFrames,
  subscribePostFrame,
} from './frameClock'
import { compileTiming, createTimingRunner } from './timing'
import { DEFAULT_PRIORITY, type RigSource, type SkinConfig, type StateDef } from './types'
import type { RigPlayback } from './useRigPlayer'
import type { SmartBvaPlacement } from './types'

type SourceListener = (source: CanvasPaintSource | null) => void

const sourceById = new Map<string, CanvasPaintSource>()
const sourceListeners = new Map<string, Set<SourceListener>>()

function publishSource(id: string, source: CanvasPaintSource | null): void {
  if (source) sourceById.set(id, source)
  else sourceById.delete(id)
  const listeners = sourceListeners.get(id)
  if (!listeners) return
  for (const fn of listeners) fn(source)
}

function subscribeSource(id: string, fn: SourceListener): () => void {
  let set = sourceListeners.get(id)
  if (!set) {
    set = new Set()
    sourceListeners.set(id, set)
  }
  set.add(fn)
  fn(sourceById.get(id) ?? null)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) sourceListeners.delete(id)
  }
}

function segmentFor(states: StateDef[] | undefined, state: string): string {
  return states?.find((s) => s.state === state)?.segment ?? state
}

export interface CanvasRigMasterProps {
  config: { id: string; asset: string; states?: StateDef[] }
  rig?: RigSource | null
  state: string
  skinConfig?: SkinConfig
  fps?: number
  priority?: number
  visibilityPxPerCanvasUnit?: number
  motionThresholdPx?: number
  drawCount?: number
  masterId: string
  onCanvas?: (canvas: { w: number; h: number }) => void
  onPlayback?: (playback: RigPlayback | null) => void
}

/** Headless owner of one CanvasRigPainter. Surfaces subscribe by masterId. */
export function CanvasRigMaster({
  config,
  rig,
  state,
  skinConfig,
  fps,
  priority,
  visibilityPxPerCanvasUnit = 0,
  motionThresholdPx = 1,
  drawCount = 1,
  masterId,
  onCanvas,
  onPlayback,
}: CanvasRigMasterProps) {
  const painterRef = useRef<CanvasRigPainter | null>(null)
  const [rawMotion, setMotion] = useState<MotionData | null>(null)
  const prepareMotion = rig?.prepareMotion
  const motion = useMemo(
    () => rawMotion && (prepareMotion?.(rawMotion) ?? rawMotion),
    [rawMotion, prepareMotion],
  )
  const [rasters, setRasters] = useState<RasterBundle | null>(null)
  const [painterEpoch, setPainterEpoch] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const skinId = skinConfig?.skin ?? null
  const hiddenParts =
    rig?.buildHiddenParts?.(skinConfig) ?? skinConfig?.hideParts
  const hiddenPartsKey = hiddenParts?.length
    ? JSON.stringify([...hiddenParts].sort())
    : ''
  const variables = rig?.buildVariables?.(skinConfig)
  const variablesKey = variables ? JSON.stringify(variables) : ''
  const variablePartsKey = (rig?.variableRasterParts ?? []).join('\0')
  const motionUrl = rig?.motionUrl
  const layerUrl = rig?.layerUrl

  const playbackRef = useRef(onPlayback)
  playbackRef.current = onPlayback
  const canvasRef = useRef(onCanvas)
  canvasRef.current = onCanvas
  const priorityRef = useRef(priority ?? DEFAULT_PRIORITY)
  priorityRef.current = priority ?? DEFAULT_PRIORITY
  const qualityKey = useRef({})
  const shapeKey = useRef({})
  const drawCountRef = useRef(drawCount)
  drawCountRef.current = drawCount

  const publishShapes = (painter: CanvasRigPainter) => {
    recordRigShapes(
      shapeKey.current,
      painter.getShapeCounts(),
      drawCountRef.current,
    )
  }

  useEffect(() => {
    const key = qualityKey.current
    registerQualityRig(key)
    return () => unregisterQualityRig(key)
  }, [])

  useEffect(() => {
    if (!motionUrl) {
      setError(`Unknown rig "${config.asset}"`)
      setMotion(null)
      return
    }
    let cancelled = false
    setError(null)
    loadMotion(motionUrl)
      .then((m) => {
        if (!cancelled) setMotion(m)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
  }, [config.asset, motionUrl])

  useEffect(() => {
    if (layerUrl) void prefetchAssetBundle(layerUrl)
  }, [layerUrl])

  useEffect(() => {
    if (!layerUrl) return
    let cancelled = false
    setError(null)
    const load = async () => {
      const rasters = await loadRasterBundle(layerUrl, {
        skin: skinId ?? undefined,
        hideParts: hiddenParts,
      })
      const vector = await loadAssetBundle(layerUrl, {
        skin: skinId ?? undefined,
        variables: variables ?? undefined,
        hideParts: hiddenParts,
      })
      return overlayVariableRasters(rasters, vector, rig?.variableRasterParts)
    }
    load()
      .then((bundle) => {
        if (!cancelled) setRasters(bundle)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
    // hiddenParts / variables are fresh objects each render; key on serialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerUrl, skinId, hiddenPartsKey, variablesKey, variablePartsKey])

  const hasRasters = rasters !== null
  useEffect(() => {
    if (!motion || !rasters) return
    const painter = new CanvasRigPainter(motion, rasters)
    painterRef.current = painter
    publishSource(masterId, painter)
    publishShapes(painter)
    canvasRef.current?.(painter.getCanvas())
    setPainterEpoch((n) => n + 1)
    return () => {
      releaseRigShapes(shapeKey.current)
      publishSource(masterId, null)
      painter.destroy()
      painterRef.current = null
    }
  }, [motion, rasters, masterId])

  useEffect(() => {
    const painter = painterRef.current
    if (!painter) return
    publishShapes(painter)
  }, [drawCount, painterEpoch])

  useEffect(() => {
    return () => releaseRigShapes(shapeKey.current)
  }, [])

  useEffect(() => {
    painterRef.current?.setVisibilityScale(
      visibilityPxPerCanvasUnit,
      motionThresholdPx,
    )
  }, [visibilityPxPerCanvasUnit, motionThresholdPx, painterEpoch])

  const clockFps = fps ?? motion?.fps ?? 24

  useEffect(() => {
    if (!motion) {
      playbackRef.current?.(null)
      return
    }
    playbackRef.current?.({
      fps: clockFps,
      segmentFrames: (s) =>
        motion.segments[
          resolveSegmentName(motion, segmentFor(config.states, s)) ?? ''
        ]?.frames ?? 0,
    })
    return () => playbackRef.current?.(null)
  }, [motion, config.states, clockFps])

  useEffect(() => {
    const painter = painterRef.current
    if (!painter || !motion) return
    const def = config.states?.find((s) => s.state === state)
    const segment = resolveSegmentName(motion, def?.segment ?? state)
    const seg = segment ? motion.segments[segment] : undefined
    if (!segment || !seg) {
      painter.gotoFrame(painter.getFrame())
      return
    }

    painter.setSegment(segment)
    publishShapes(painter)
    const runner = createTimingRunner(compileTiming(def?.timing, seg.frames))
    painter.gotoFrame(runner.currentFrame())
    if (runner.done()) return

    let remaining = 0
    return subscribeFrames(clockFps, (frames) => {
      const frame = runner.advance(frames)
      if (remaining > 0) {
        remaining -= 1
        recordPoseSkip()
        return
      }
      painter.gotoFrame(frame)
      remaining = skipNForPriority(priorityRef.current)
    })
  }, [motion, state, config.states, clockFps, painterEpoch])

  const ready = motion !== null && hasRasters
  useEffect(() => {
    if (ready || error || !layerUrl) markQualityRigReady(qualityKey.current)
  }, [ready, error, layerUrl])

  return null
}

export interface CanvasImageMasterProps {
  masterId: string
  path: string
  size: { w: number; h: number }
}

/** Headless owner of one CanvasImageSource. Surfaces subscribe by masterId. */
export function CanvasImageMaster({
  masterId,
  path,
  size,
}: CanvasImageMasterProps) {
  useEffect(() => {
    const source = new CanvasImageSource(path, size)
    publishSource(masterId, source)
    return () => {
      publishSource(masterId, null)
      source.destroy()
    }
  }, [masterId, path, size.w, size.h])

  return null
}

export interface CanvasSurfaceEntry {
  key: string
  sourceId: string
  placement: SmartBvaPlacement
  canvas: { w: number; h: number }
  baseScale: number
  zIndex: number
}

export interface CanvasSurfaceProps {
  surfaceKey: string
  zIndex: number
  entries: CanvasSurfaceEntry[]
  fit: number
  dpr: number
  poseCache?: boolean
  repaint?: 'dirty' | 'full'
}

const DIRTY_FULL_CLEAR_RATIO = 0.6

interface PaintedEntry {
  poseKey: string
  cssRect: Rect | null
}

function measureSurface(
  entries: CanvasSurfaceEntry[],
  sources: Map<string, CanvasPaintSource>,
  fit: number,
): Rect | null {
  const rects: Rect[] = []
  for (const entry of entries) {
    const source = sources.get(entry.sourceId)
    if (!source) continue
    const bounds = source.contentBounds()
    if (!bounds) continue
    const m = placementDrawMatrix(
      entry.placement,
      entry.canvas,
      fit,
      entry.baseScale,
    )
    rects.push(transformRect(m, bounds))
  }
  return unionRects(rects)
}

function entryCssRect(
  entry: CanvasSurfaceEntry,
  source: CanvasPaintSource,
  fit: number,
): Rect | null {
  const bounds = source.contentBounds()
  if (!bounds) return null
  return transformRect(
    placementDrawMatrix(entry.placement, entry.canvas, fit, entry.baseScale),
    bounds,
  )
}

function expandRect(rect: Rect, pad: number): Rect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    w: rect.w + pad * 2,
    h: rect.h + pad * 2,
  }
}

/**
 * One Canvas2D surface for a `type: "canvas"` asset (or a legacy z-contiguous
 * run of canvas-flagged smartbva draws).
 */
export function CanvasSurface({
  surfaceKey,
  zIndex,
  entries,
  fit,
  dpr,
  poseCache = false,
  repaint = 'dirty',
}: CanvasSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const sourcesRef = useRef(new Map<string, CanvasPaintSource>())
  const lastPainted = useRef(new Map<string, PaintedEntry>())
  const lastSurfaceBox = useRef<string | null>(null)
  const dirtyRef = useRef(true)
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const poseCacheRef = useRef(poseCache)
  const [box, setBox] = useState<Rect | null>(null)
  const [sourceEpoch, setSourceEpoch] = useState(0)
  const entriesKey = entries.map((e) => e.key).join('\0')
  const layoutKey = entries
    .map(
      (e) =>
        `${e.key}:${e.placement.position[0]},${e.placement.position[1]},${e.placement.scale ?? 1},${e.placement.mirror ? 1 : 0},${e.baseScale},${e.canvas.w}x${e.canvas.h},${e.sourceId},${e.zIndex}`,
    )
    .join('|')

  useEffect(() => {
    if (poseCacheRef.current && !poseCache) {
      for (const source of sourcesRef.current.values()) source.clearCache()
    }
    poseCacheRef.current = poseCache
    dirtyRef.current = true
  }, [poseCache])

  useEffect(() => {
    const sourceIds = [...new Set(entries.map((e) => e.sourceId))]
    const unsubs = sourceIds.map((id) =>
      subscribeSource(id, (source) => {
        if (source) sourcesRef.current.set(id, source)
        else sourcesRef.current.delete(id)
        lastPainted.current.clear()
        dirtyRef.current = true
        setSourceEpoch((n) => n + 1)
      }),
    )
    return () => {
      for (const unsub of unsubs) unsub()
    }
    // entriesKey is the stable identity of this surface's draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entriesKey])

  useEffect(() => {
    const next = measureSurface(entriesRef.current, sourcesRef.current, fit)
    setBox((prev) => {
      if (
        prev &&
        next &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.w === next.w &&
        prev.h === next.h
      ) {
        return prev
      }
      return next
    })
    dirtyRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, fit, dpr, sourceEpoch])

  useEffect(() => {
    const paint = () => {
      const el = canvasRef.current
      if (!el) return
      const ctx = el.getContext('2d')
      if (!ctx) return

      const measured = measureSurface(entriesRef.current, sourcesRef.current, fit)
      if (!measured || !(measured.w > 0) || !(measured.h > 0)) return

      const live = entriesRef.current
      const dirtyRects: Rect[] = []
      let missing = false
      for (const entry of live) {
        const source = sourcesRef.current.get(entry.sourceId)
        if (!source) {
          missing = true
          continue
        }
        const poseKey = source.poseKey()
        const prev = lastPainted.current.get(entry.key)
        const cssRect = entryCssRect(entry, source, fit)
        if (
          !prev ||
          prev.poseKey !== poseKey ||
          source.movedSince(prev.poseKey)
        ) {
          if (prev?.cssRect) dirtyRects.push(prev.cssRect)
          if (cssRect) dirtyRects.push(cssRect)
        }
      }
      const force = dirtyRef.current || missing
      const dirtyUnion = unionRects(dirtyRects)
      if (!force && !dirtyUnion) return

      const cssX = Math.floor(measured.x)
      const cssY = Math.floor(measured.y)
      const cssW = Math.max(1, Math.ceil(measured.x + measured.w) - cssX)
      const cssH = Math.max(1, Math.ceil(measured.y + measured.h) - cssY)
      const bw = Math.max(1, Math.round(cssW * dpr))
      const bh = Math.max(1, Math.round(cssH * dpr))
      // Resizing a canvas clears its entire backing store, and moving its CSS
      // origin invalidates the coordinate space of every retained pixel.
      // Either change therefore needs a full repaint, not a dirty-rect pass.
      const surfaceBox = `${cssX},${cssY},${cssW},${cssH},${bw},${bh}`
      const surfaceChanged = lastSurfaceBox.current !== surfaceBox
      lastSurfaceBox.current = surfaceBox
      if (el.width !== bw || el.height !== bh) {
        el.width = bw
        el.height = bh
      }
      el.style.left = `${cssX}px`
      el.style.top = `${cssY}px`
      el.style.width = `${cssW}px`
      el.style.height = `${cssH}px`

      const surfaceArea = cssW * cssH
      const dirtyArea = dirtyUnion ? rectArea(expandRect(dirtyUnion, 1)) : 0
      const fullClear =
        force ||
        surfaceChanged ||
        repaint === 'full' ||
        !dirtyUnion ||
        (surfaceArea > 0 && dirtyArea / surfaceArea > DIRTY_FULL_CLEAR_RATIO)

      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (fullClear) {
        ctx.clearRect(0, 0, bw, bh)
      } else if (dirtyUnion) {
        const pad = expandRect(dirtyUnion, 1)
        const dx = (pad.x - cssX) * dpr
        const dy = (pad.y - cssY) * dpr
        const dw = pad.w * dpr
        const dh = pad.h * dpr
        ctx.save()
        ctx.beginPath()
        ctx.rect(dx, dy, dw, dh)
        ctx.clip()
        ctx.clearRect(dx, dy, dw, dh)
      }

      const surfaceToDevice = mul6(scale6(dpr, dpr), translate6(-cssX, -cssY))
      const clip = !fullClear && dirtyUnion ? expandRect(dirtyUnion, 1) : null
      let imagesReady = true
      for (const entry of live) {
        const source = sourcesRef.current.get(entry.sourceId)
        if (!source) continue
        const cssRect = entryCssRect(entry, source, fit)
        if (clip && cssRect && !rectsIntersect(cssRect, clip)) {
          continue
        }
        const placementScale = (entry.placement.scale ?? 1) * entry.baseScale
        const matrix = placementDrawMatrix(
          entry.placement,
          entry.canvas,
          fit,
          entry.baseScale,
        )
        const ready = source.paintInto(ctx, surfaceToDevice, {
          matrix,
          pxPerCanvasUnit: fit * dpr * placementScale,
          placementScale,
          fit,
          dpr,
          poseCache,
        })
        if (!ready) imagesReady = false
        lastPainted.current.set(entry.key, {
          poseKey: source.poseKey(),
          cssRect,
        })
      }
      if (!fullClear) ctx.restore()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      dirtyRef.current = !imagesReady
    }

    paint()
    const unsubPost = subscribePostFrame(paint)
    const unsubRasters = subscribeRasterImages(() => {
      dirtyRef.current = true
      paint()
    })
    const unsubImgs = subscribeCanvasImages(() => {
      dirtyRef.current = true
      paint()
    })
    return () => {
      unsubPost()
      unsubRasters()
      unsubImgs()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, fit, dpr, sourceEpoch, poseCache, repaint])

  return (
    <canvas
      ref={canvasRef}
      className="gamefield-canvas-surface"
      data-surface={surfaceKey}
      style={{ zIndex, display: box ? undefined : 'none' }}
    />
  )
}

/** @deprecated Use {@link CanvasRigMaster}. */
export const CanvasSmartBvaMaster = CanvasRigMaster
/** @deprecated Use {@link CanvasSurface}. */
export const CanvasBandSurface = CanvasSurface
/** @deprecated Use {@link CanvasSurfaceEntry}. */
export type CanvasBandEntry = CanvasSurfaceEntry
export type CanvasBandSurfaceProps = CanvasSurfaceProps
export type CanvasSmartBvaMasterProps = CanvasRigMasterProps
