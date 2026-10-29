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
import {
  RasteredRigPainter,
  overlayVariableRasters,
  type RasterInstanceHandle,
} from '../rastered-rig-painter'
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
} from './frameClock'
import { compileTiming, createTimingRunner } from './timing'
import { DEFAULT_PRIORITY, type RigSource, type SkinConfig, type StateDef } from './types'
import type { RigPlayback } from './useRigPlayer'
import type { SmartBvaPlacement } from './types'

type PainterListener = (painter: RasteredRigPainter | null) => void

const painterByMaster = new Map<string, RasteredRigPainter>()
const painterListeners = new Map<string, Set<PainterListener>>()

function publishPainter(masterId: string, painter: RasteredRigPainter | null): void {
  if (painter) painterByMaster.set(masterId, painter)
  else painterByMaster.delete(masterId)
  const listeners = painterListeners.get(masterId)
  if (!listeners) return
  for (const fn of listeners) fn(painter)
}

function subscribePainter(masterId: string, fn: PainterListener): () => void {
  let set = painterListeners.get(masterId)
  if (!set) {
    set = new Set()
    painterListeners.set(masterId, set)
  }
  set.add(fn)
  fn(painterByMaster.get(masterId) ?? null)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) painterListeners.delete(masterId)
  }
}

function segmentFor(states: StateDef[] | undefined, state: string): string {
  return states?.find((s) => s.state === state)?.segment ?? state
}

export interface RasteredSmartBvaMasterProps {
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

/** Headless owner of one RasteredRigPainter ticker, referenced by its draws. */
export function RasteredSmartBvaMaster({
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
}: RasteredSmartBvaMasterProps) {
  const painterRef = useRef<RasteredRigPainter | null>(null)
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

  const publishShapes = (painter: RasteredRigPainter) => {
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
    const painter = new RasteredRigPainter(motion, rasters)
    painterRef.current = painter
    publishPainter(masterId, painter)
    publishShapes(painter)
    canvasRef.current?.(painter.getCanvas())
    setPainterEpoch((n) => n + 1)
    return () => {
      releaseRigShapes(shapeKey.current)
      publishPainter(masterId, null)
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

export interface RasteredSmartBvaDrawProps {
  placement: SmartBvaPlacement
  canvas: { w: number; h: number }
  fit?: number
  baseScale?: number
  zIndex: number
  masterId: string
  /** Device pixels per canvas unit for this copy (fit × dpr × scale). */
  pxPerCanvasUnit: number
}

/**
 * One HTML copy of a rastered master, registered into its RasteredRigPainter.
 */
export function RasteredSmartBvaDraw({
  placement,
  canvas,
  fit = 1,
  baseScale = 1,
  zIndex,
  masterId,
  pxPerCanvasUnit,
}: RasteredSmartBvaDrawProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    let handle: RasterInstanceHandle | null = null
    let attached: RasteredRigPainter | null = null
    const release = () => {
      if (handle && attached) attached.removeInstance(handle)
      handle = null
      attached = null
    }
    const unsub = subscribePainter(masterId, (painter) => {
      release()
      if (!painter) return
      attached = painter
      handle = painter.addInstance(el, { pxPerCanvasUnit })
    })
    return () => {
      unsub()
      release()
    }
  }, [masterId, pxPerCanvasUnit])

  const scale = (placement.scale ?? 1) * baseScale
  const sx = placement.mirror ? -scale : scale
  const transform =
    `translate(${placement.position[0] * fit}px, ${placement.position[1] * fit}px) ` +
    `scale(${sx * fit}, ${scale * fit}) ` +
    `translate(${-canvas.w / 2}px, ${-canvas.h / 2}px)`

  return (
    <div
      ref={containerRef}
      className="gamefield-raster-draw"
      style={{
        zIndex,
        transform,
        width: canvas.w,
        height: canvas.h,
      }}
    />
  )
}
