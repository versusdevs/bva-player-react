import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BakedVectorPlayer,
  loadAssetBundle,
  loadMotion,
  prefetchAssetBundle,
  resolveSegmentName,
  type AssetBundle,
  type MotionData,
} from '../baked-vector-animation'
import { cullThresholdsFor } from './cullTier'
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

export interface RigPlayback {
  /** Frames in the segment a logical state maps to; 0 when unknown. */
  segmentFrames: (state: string) => number
  fps: number
}

export interface UseRigPlayerOptions {
  /** Config `asset` name, used in error messages. */
  asset: string
  /** Resolved source for this name. Missing → "Unknown rig". */
  rig?: RigSource | null
  skinConfig?: SkinConfig
  states?: StateDef[]
  state: string
  /** Field-level frame rate for timing programs. Defaults to the motion's. */
  fps?: number
  /**
   * Resolved cooldown priority (0–1). Read each write so Studio edits apply
   * without resetting the timing runner.
   */
  priority?: number
  /**
   * Device pixels one canvas unit covers for this instance, used to skip pose
   * writes that move nothing. `0` / omitted keeps the scale-blind behaviour.
   * For a SmartBVA master this must be the scale of its largest copy.
   */
  visibilityPxPerCanvasUnit?: number
  /**
   * On-screen scale the bundle is culled for, in device pixels per canvas unit.
   * `null` / omitted mounts every shape. Quantized by `cullScaleFor` so copies
   * at similar sizes share one bundle rather than re-serializing per instance.
   */
  cullScale?: number | null
  /**
   * Shape culling threshold in device pixels — the field's CSS-pixel setting
   * already multiplied by the device pixel ratio.
   */
  cullThresholdPx?: number
  /** Movement below this many device pixels is not written. */
  motionThresholdPx?: number
  /**
   * How many times this rig's shapes are painted. 1 for a solo BVA; for a
   * SmartBVA master, the number of visible `<use>` copies. The field HUD
   * multiplies mounted/culled by this so a still crowd still counts.
   */
  drawCount?: number
  onPlayerCreated?: (player: BakedVectorPlayer) => void
  onPlayback?: (playback: RigPlayback | null) => void
}

function segmentFor(states: StateDef[] | undefined, state: string): string {
  return states?.find((s) => s.state === state)?.segment ?? state
}

/**
 * Loads a rig, mounts a `BakedVectorPlayer` into the returned container, and
 * drives it frame by frame from the field clock according to the current
 * state's timing program. The player's own playback loop is never started —
 * timing programs need frame-level control (ranges, holds, stops) that
 * `play()` does not offer.
 */
export function useRigPlayer({
  asset,
  rig,
  skinConfig,
  states,
  state,
  fps,
  priority,
  visibilityPxPerCanvasUnit = 0,
  cullScale = null,
  cullThresholdPx = 1,
  motionThresholdPx = 1,
  drawCount = 1,
  onPlayerCreated,
  onPlayback,
}: UseRigPlayerOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<BakedVectorPlayer | null>(null)
  const [rawMotion, setMotion] = useState<MotionData | null>(null)
  const prepareMotion = rig?.prepareMotion
  const motion = useMemo(
    () => rawMotion && (prepareMotion?.(rawMotion) ?? rawMotion),
    [rawMotion, prepareMotion],
  )
  const [bundle, setBundle] = useState<AssetBundle | null>(null)
  const [playerEpoch, setPlayerEpoch] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const skinId = skinConfig?.skin ?? null
  const buildVariables = rig?.buildVariables
  const variables = buildVariables?.(skinConfig)
  const variablesKey = variables ? JSON.stringify(variables) : ''
  const hiddenParts =
    rig?.buildHiddenParts?.(skinConfig) ?? skinConfig?.hideParts
  const hiddenPartsKey = hiddenParts?.length
    ? JSON.stringify([...hiddenParts].sort())
    : ''
  const skinKey = JSON.stringify(skinConfig ?? null)
  const motionUrl = rig?.motionUrl
  const layerUrl = rig?.layerUrl

  const createdRef = useRef(onPlayerCreated)
  createdRef.current = onPlayerCreated
  const playbackRef = useRef(onPlayback)
  playbackRef.current = onPlayback
  const prepareRef = useRef(rig?.prepareBundle)
  prepareRef.current = rig?.prepareBundle
  const skinRef = useRef(skinConfig)
  skinRef.current = skinConfig
  const priorityRef = useRef(priority ?? DEFAULT_PRIORITY)
  priorityRef.current = priority ?? DEFAULT_PRIORITY
  const qualityKey = useRef({})
  // Stable across player rebuilds so the field's shape census keeps one entry
  // per rig instead of leaking one per remount.
  const shapeKey = useRef({})
  const drawCountRef = useRef(drawCount)
  drawCountRef.current = drawCount

  const publishShapes = (player: BakedVectorPlayer) => {
    recordRigShapes(shapeKey.current, player.getShapeCounts(), drawCountRef.current)
  }

  useEffect(() => {
    const key = qualityKey.current
    registerQualityRig(key)
    return () => unregisterQualityRig(key)
  }, [])

  useEffect(() => {
    if (!motionUrl) {
      setError(`Unknown rig "${asset}"`)
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
  }, [asset, motionUrl])

  // Start the layer download as soon as the URL is known. Resolving it waits
  // for the motion below, but the bytes do not have to.
  useEffect(() => {
    if (layerUrl) void prefetchAssetBundle(layerUrl)
  }, [layerUrl])

  // Culling thresholds are in each part's local units, which means they depend
  // on the part matrices — hence on the motion. Scale and threshold are already
  // quantized, so this map is shared by every copy at the same quantized scale.
  const cullBelowLocal = useMemo(() => {
    if (!motion || cullScale == null || !(cullScale > 0)) return undefined
    return cullThresholdsFor(motion, cullScale, cullThresholdPx)
  }, [motion, cullScale, cullThresholdPx])

  useEffect(() => {
    if (!layerUrl || !motion) return
    let cancelled = false
    setError(null)

    const load = async () => {
      const resolved = await loadAssetBundle(layerUrl, {
        skin: skinId ?? undefined,
        variables: variables ?? undefined,
        hideParts: hiddenParts,
        cullBelowLocal,
      })
      const prepare = prepareRef.current
      if (!prepare) return resolved
      return prepare(resolved, skinRef.current)
    }

    load()
      .then((b) => {
        if (!cancelled) setBundle(b)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(String(err))
      })
    return () => {
      cancelled = true
    }
    // `variables` / `hiddenParts` are fresh objects each render; key on serialization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layerUrl, motion, skinId, variablesKey, hiddenPartsKey, skinKey, cullBelowLocal])

  const hasBundle = bundle !== null
  useEffect(() => {
    const el = containerRef.current
    if (!el || !motion || !bundle) return
    const player = new BakedVectorPlayer(el, motion, bundle, {
      useSharedTicker: false,
    })
    playerRef.current = player
    publishShapes(player)
    createdRef.current?.(player)
    setPlayerEpoch((n) => n + 1)
    return () => {
      releaseRigShapes(shapeKey.current)
      player.destroy()
      playerRef.current = null
    }
    // Recreate only when the motion changes or the first bundle arrives;
    // later skin edits are swapped in below without resetting time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [motion, hasBundle])

  useEffect(() => {
    const player = playerRef.current
    if (!bundle || !player) return
    player.setBundle(bundle)
    publishShapes(player)
  }, [bundle])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    publishShapes(player)
  }, [drawCount])

  useEffect(() => {
    return () => releaseRigShapes(shapeKey.current)
  }, [])

  // Just a pair of numbers, so this can follow the viewport freely: unlike a
  // tier change it never re-resolves a bundle or remounts parts.
  useEffect(() => {
    playerRef.current?.setVisibilityScale(
      visibilityPxPerCanvasUnit,
      motionThresholdPx,
    )
  }, [visibilityPxPerCanvasUnit, motionThresholdPx, playerEpoch, bundle])

  const clockFps = fps ?? motion?.fps ?? 24

  useEffect(() => {
    if (!motion) {
      playbackRef.current?.(null)
      return
    }
    playbackRef.current?.({
      fps: clockFps,
      segmentFrames: (s) =>
        motion.segments[resolveSegmentName(motion, segmentFor(states, s)) ?? '']
          ?.frames ?? 0,
    })
    return () => playbackRef.current?.(null)
  }, [motion, states, clockFps])

  useEffect(() => {
    const player = playerRef.current
    if (!player || !motion) return
    const def = states?.find((s) => s.state === state)
    const segment = resolveSegmentName(motion, def?.segment ?? state)
    const seg = segment ? motion.segments[segment] : undefined
    if (!segment || !seg) return

    player.setSegment(segment)
    // Segments mount different parts, so the census moves with the state.
    publishShapes(player)
    const runner = createTimingRunner(compileTiming(def?.timing, seg.frames))
    player.gotoFrame(runner.currentFrame())
    if (runner.done()) return

    let remaining = 0
    return subscribeFrames(clockFps, (frames) => {
      const frame = runner.advance(frames)
      if (remaining > 0) {
        remaining -= 1
        recordPoseSkip()
        return
      }
      player.gotoFrame(frame)
      remaining = skipNForPriority(priorityRef.current)
    })
  }, [motion, state, states, clockFps, playerEpoch])

  const ready = motion !== null && hasBundle
  useEffect(() => {
    if (ready || error || !layerUrl) markQualityRigReady(qualityKey.current)
  }, [ready, error, layerUrl])

  return { containerRef, motion, error, ready }
}
