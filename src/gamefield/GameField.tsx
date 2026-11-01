import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { BvaAsset } from './BvaAsset'
import { BvaLoadingOverlay } from '../BvaLoader'
import { cullScaleFor, cullTierFor } from './cullTier'
import { setForceWeak, setQualityConfig } from './fieldQuality'
import { createFieldAudio, type FieldAudio } from './fieldAudio'
import {
  canvasPlacement,
  findFieldAsset,
  flattenAssets,
  smartMasterId,
  smartVariants,
  type FlatAsset,
} from './layout'
import {
  placementQualityKey,
  resolveAssetQuality,
  resolveFieldQuality,
  resolveSmartCulling,
} from './resolveQuality'
import { SmartBvaDraw, SmartBvaMaster } from './SmartBvaAsset'
import {
  collectSoundUrls,
  findSoundState,
  resolveClipUrl,
  soundChannel,
  soundVolume,
} from './soundAssets'
import { useFieldQuality } from './useFieldQuality'
import { useFieldSounds } from './useFieldSounds'
import { useDevicePixelRatio, useFitScale } from './useFitScale'
import type { RigPlayback } from './useRigPlayer'
import { RasteredSmartBvaDraw, RasteredSmartBvaMaster } from './RasteredSmartBva'
import {
  CanvasImageMaster,
  CanvasRigMaster,
  CanvasSurface,
} from './CanvasRig'
import type { CanvasSurfaceEntry } from './CanvasRig'
import {
  DEFAULT_CANVAS,
  DEFAULT_FULL,
  DEFAULT_PRIORITY,
  DEFAULT_RASTERED,
  DEFAULT_RENDER_ON_WEAK,
  isContainerAsset,
  resolveCanvasPoseCache,
  type CanvasAssetConfig,
} from './types'
import {
  EMPTY_WEAK_DISTRIBUTION_CULLS,
  resolveWeakDistributionCulls,
} from './weakDistribution'
import type { SmartSkinVariant } from './layout'
import type {
  GameFieldAsset,
  GameFieldConfig,
  GameFieldHandle,
  RigSource,
  SkinConfig,
  SmartBvaAssetConfig,
  Vec2,
} from './types'

interface StateEntry {
  state: string
  /** Monotonic; the most recently set of group / item wins. */
  seq: number
}

function initialStates(flat: FlatAsset[]): Record<string, StateEntry> {
  const out: Record<string, StateEntry> = {}
  for (const { asset } of flat) {
    const state = asset.state ?? asset.states?.[0]?.state
    if (state) out[asset.id] = { state, seq: 0 }
  }
  return out
}

export interface GameFieldProps {
  /** Custom loading content. Omit for the default; null lets the host own loading. */
  loader?: ReactNode
  /** Called when the scene rigs have finished initializing. */
  onReady?: () => void
  config: GameFieldConfig
  /** Map of config `asset` names to baked file URLs and optional hooks. */
  rigs: Record<string, RigSource>
  /** Live skin edits from the host, keyed by asset id. */
  skinOverrides?: Record<string, SkinConfig>
  /** Contents of configured HTML assets, keyed by asset id. */
  slots?: Record<string, ReactNode>
  /** Draws a marker at the selected asset's placements. */
  selectedAssetId?: string | null
  /**
   * When set with {@link selectedAssetId} on a smartbva cluster, only that
   * placement is marked. Omit to ring every copy of the selected cluster.
   */
  selectedPlacementIndex?: number | null
  /**
   * Fit scale the field settled on after measuring its wrapper, for hosts that
   * display it. The field applies it itself.
   */
  onFitChange?: (fit: number) => void
  /**
   * Device pixel ratio to plan culling and motion cutting for, instead of the
   * real display's. Lets a desktop preview what a phone would resolve.
   *
   * This is a planning override only: the browser still rasterizes at its own
   * ratio, so a lower value shows what a phone would *drop*, not how a phone
   * would look.
   */
  devicePixelRatio?: number | null
  /**
   * Treat the field as a weak device immediately: unmount assets /
   * placements with `renderOnWeakDevice: false` and apply
   * `weakDeviceDistributionRatio`. Lets a host preview that cull without
   * waiting for the measure window to fail.
   */
  forceWeakDevice?: boolean
  /**
   * Logical clip name → URL. A sound state's `clip` looks up this map;
   * a missing key is treated as a URL (same as `image.path`).
   */
  clips?: Record<string, string>
  /** Looping beds (`channel: 'bg'`). Default `true`. */
  bgEnabled?: boolean
  /** Fade background music out while idle, then pause it. */
  bgPaused?: boolean
  /** One-shots and cues (`channel: 'sfx'`). Default `true`. */
  sfxEnabled?: boolean
  /** Master gain 0..1. Default `1`. */
  volume?: number
}

export const GameField = forwardRef<GameFieldHandle, GameFieldProps>(
  function GameField(
    {
      config,
      rigs,
      skinOverrides,
      slots,
      selectedAssetId,
      selectedPlacementIndex,
      onFitChange,
      onReady,
      loader,
      devicePixelRatio: dprOverride,
      forceWeakDevice = false,
      clips,
      bgEnabled = true,
      bgPaused = false,
      sfxEnabled = true,
      volume = 1,
    },
    ref,
  ) {
    const flat = useMemo(() => flattenAssets(config.assets), [config])
    const qualityMap = useMemo(
      () => resolveAssetQuality(config.assets),
      [config],
    )
    const quality = useFieldQuality(config.id)
    const hideWeak =
      forceWeakDevice || (quality.phase === 'run' && quality.weak)
    const { ref: fitRef, fit } = useFitScale(config.size)
    const displayDpr = useDevicePixelRatio()
    const dpr =
      dprOverride != null && Number.isFinite(dprOverride) && dprOverride > 0
        ? dprOverride
        : displayDpr
    const smartCulling = useMemo(() => resolveSmartCulling(config), [config])
    const culls = useMemo(
      () =>
        hideWeak
          ? resolveWeakDistributionCulls(config.assets, qualityMap, config.id)
          : EMPTY_WEAK_DISTRIBUTION_CULLS,
      [hideWeak, config.assets, config.id, qualityMap],
    )

    useEffect(() => {
      setQualityConfig(resolveFieldQuality(config))
    }, [config])

    const fieldPoseCache = resolveCanvasPoseCache(config)
    const canvasById = useMemo(() => {
      const map = new Map<string, CanvasAssetConfig>()
      for (const { asset } of flat) {
        if (asset.type === 'canvas') map.set(asset.id, asset)
      }
      return map
    }, [flat])

    useEffect(() => {
      setForceWeak(forceWeakDevice)
      return () => setForceWeak(false)
    }, [forceWeakDevice])

    const fitChangeRef = useRef(onFitChange)
    fitChangeRef.current = onFitChange
    useEffect(() => {
      fitChangeRef.current?.(fit)
    }, [fit])

    const [states, setStates] = useState(() => initialStates(flat))
    const [activeOverrides, setActiveOverrides] = useState<
      Record<string, boolean>
    >({})
    const [canvases, setCanvases] = useState<
      Record<string, { w: number; h: number }>
    >({})
    const [localSkins, setLocalSkins] = useState<
      Record<string, Partial<SkinConfig>>
    >({})
    const seqRef = useRef(0)
    const playbackRef = useRef<Record<string, RigPlayback>>({})
    const audioRef = useRef<FieldAudio | null>(null)
    if (audioRef.current == null) {
      audioRef.current = createFieldAudio({
        volume,
        bgEnabled,
        bgPaused,
        sfxEnabled,
      })
    }
    const audio = audioRef.current
    const cueTimersRef = useRef<Map<string, number[]>>(new Map())
    const clipsRef = useRef(clips)
    clipsRef.current = clips
    const configRef = useRef(config)
    configRef.current = config
    const sfxEnabledRef = useRef(sfxEnabled)
    sfxEnabledRef.current = sfxEnabled

    const parentOf = useMemo(() => {
      const map: Record<string, string | null> = {}
      for (const node of flat) map[node.asset.id] = node.parentId
      return map
    }, [flat])

    /** Group state wins over its items unless an item was set more recently. */
    const effectiveState = useCallback(
      (id: string): string => {
        const own = states[id]
        const parentId = parentOf[id]
        const parent = parentId ? states[parentId] : undefined
        if (own && parent) return parent.seq >= own.seq ? parent.state : own.state
        return (parent ?? own)?.state ?? 'idle'
      },
      [states, parentOf],
    )

    const setAssetState = useCallback((id: string, state: string) => {
      seqRef.current += 1
      const seq = seqRef.current
      setStates((prev) => ({ ...prev, [id]: { state, seq } }))
    }, [])

    const clearCueTimers = useCallback((id?: string) => {
      if (id) {
        const timers = cueTimersRef.current.get(id)
        timers?.forEach((timer) => window.clearTimeout(timer))
        cueTimersRef.current.delete(id)
        return
      }
      for (const timers of cueTimersRef.current.values()) {
        timers.forEach((timer) => window.clearTimeout(timer))
      }
      cueTimersRef.current.clear()
    }, [])

    const stopSound = useCallback(
      (id: string) => {
        clearCueTimers(id)
        audio.stop(id)
      },
      [audio, clearCueTimers],
    )

    const playSound = useCallback(
      (id: string, cue?: string) => {
        const asset = findFieldAsset(configRef.current, id)
        if (!asset || asset.type !== 'sound') return
        if (!sfxEnabledRef.current) return

        stopSound(id)

        const playClip = (clip: string, stepVolume?: number) => {
          audio.play({
            id,
            url: resolveClipUrl(clip, clipsRef.current),
            loop: false,
            volume: soundVolume(asset, undefined, stepVolume),
            channel: soundChannel(asset, false),
          })
        }

        if (cue) {
          const steps = asset.cues?.[cue]
          if (!steps?.length) return
          const timers: number[] = []
          for (const step of steps) {
            const delay = step.at ?? 0
            if (delay <= 0) {
              playClip(step.clip, step.volume)
              continue
            }
            timers.push(
              window.setTimeout(() => playClip(step.clip, step.volume), delay),
            )
          }
          if (timers.length) cueTimersRef.current.set(id, timers)
          return
        }

        const def = findSoundState(asset, asset.state ?? '')
        const clip = def?.clip ?? asset.clip
        if (!clip) return
        playClip(clip, def?.volume)
      },
      [audio, stopSound],
    )

    useEffect(() => {
      audio.setVolume(volume)
    }, [audio, volume])

    useEffect(() => {
      audio.setBackgroundPaused(bgPaused)
    }, [audio, bgPaused])

    useEffect(() => {
      audio.setEnabled(bgEnabled, sfxEnabled)
    }, [audio, bgEnabled, sfxEnabled])

    useEffect(() => {
      audio.preload(collectSoundUrls(config, clips))
    }, [audio, config, clips])

    useEffect(() => {
      return () => {
        clearCueTimers()
        audio.stopAll()
      }
    }, [audio, clearCueTimers])

    const setAssetSkin = useCallback((id: string, patch: Partial<SkinConfig>) => {
      setLocalSkins((prev) => {
        const current = prev[id]
        return {
          ...prev,
          [id]: {
            ...current,
            ...patch,
            colors: { ...current?.colors, ...patch.colors },
          },
        }
      })
    }, [])

    useImperativeHandle(
      ref,
      (): GameFieldHandle => ({
        setAssetState,
        getAssetState: (id) => states[id]?.state ?? null,
        setAssetActive: (id, active) =>
          setActiveOverrides((prev) => ({ ...prev, [id]: active })),
        setAssetSkin,
        getStateDurationMs: (id, state) => {
          const playback = playbackRef.current[id]
          if (!playback) return 0
          const frames = playback.segmentFrames(state)
          return frames > 0 ? (frames / playback.fps) * 1000 : 0
        },
        playSound,
        stopSound,
      }),
      [setAssetState, setAssetSkin, states, playSound, stopSound],
    )

    const isActive = useCallback(
      (asset: GameFieldAsset): boolean => {
        let id: string | null = asset.id
        while (id) {
          const override = activeOverrides[id]
          const node = flat.find((entry) => entry.asset.id === id)
          const configured = node?.asset.active !== false
          const active = override !== undefined ? override : configured
          if (!active) return false
          id = parentOf[id] ?? null
        }
        return true
      },
      [activeOverrides, flat, parentOf],
    )

    const registerPlayback = useCallback(
      (id: string, playback: RigPlayback | null) => {
        if (playback) playbackRef.current[id] = playback
        else delete playbackRef.current[id]
      },
      [],
    )

    const fieldSize = config.size

    const qualityOf = (id: string) =>
      qualityMap.get(id) ?? {
        priority: DEFAULT_PRIORITY,
        renderOnWeakDevice: DEFAULT_RENDER_ON_WEAK,
        full: DEFAULT_FULL,
        rastered: DEFAULT_RASTERED,
        canvas: DEFAULT_CANVAS,
        cullThresholdCssPx: undefined,
      }

    // How many device pixels one canvas unit covers once the field is fitted
    // to its wrapper. Everything resolution-aware is derived from this.
    const pxPerCanvasUnit = fit * dpr

    /**
     * Culling inputs for one rig, or nulls when it must render in full.
     *
     * `scale` is the rig's own scale on top of the field fit. A SmartBVA
     * master serves every copy that references it, so callers pass the largest
     * copy's scale — culling for a smaller one would visibly strip detail from
     * the near copies.
     */
    const cullingFor = (
      assetId: string,
      scale: number,
    ): {
      cullScale: number | null
      visibilityPx: number
      cullThresholdPx: number
    } => {
      const quality = qualityOf(assetId)
      // The threshold is authored in CSS pixels because that is the unit
      // visibility is judged in; the culler itself works in device pixels.
      const cullThresholdPx =
        (quality.cullThresholdCssPx ?? smartCulling.cullThresholdCssPx) * dpr
      if (!smartCulling.enabled || quality.full) {
        return { cullScale: null, visibilityPx: 0, cullThresholdPx }
      }
      const px = pxPerCanvasUnit * scale
      return { cullScale: cullScaleFor(px), visibilityPx: px, cullThresholdPx }
    }


    const drawsOnWeak = (asset: GameFieldAsset): boolean => {
      if (!hideWeak) return true
      if (culls.hiddenAssetIds.has(asset.id)) return false
      return qualityOf(asset.id).renderOnWeakDevice
    }

    const soundPlayback = useMemo(() => {
      const out: Record<string, { state: string; seq: number; active: boolean }> =
        {}
      for (const { asset } of flat) {
        if (asset.type !== 'sound') continue
        const own = states[asset.id]
        const parentId = parentOf[asset.id]
        const parent = parentId ? states[parentId] : undefined
        const seq =
          own && parent
            ? parent.seq >= own.seq
              ? parent.seq
              : own.seq
            : (parent ?? own)?.seq ?? 0
        out[asset.id] = {
          state: effectiveState(asset.id),
          seq,
          active: isActive(asset) && drawsOnWeak(asset),
        }
      }
      return out
    }, [flat, states, parentOf, effectiveState, isActive, hideWeak, culls])

    useFieldSounds(flat, soundPlayback, clips, audio, bgEnabled, sfxEnabled)

    const placementDrawsOnWeak = (
      asset: GameFieldAsset,
      placement: { renderOnWeakDevice?: boolean },
      placementIndex: number,
    ): boolean => {
      if (!hideWeak) return true
      if (culls.hiddenAssetIds.has(asset.id)) return false
      if (
        culls.hiddenPlacementKeys.has(
          placementQualityKey(asset.id, placementIndex),
        )
      ) {
        return false
      }
      return (
        placement.renderOnWeakDevice ?? qualityOf(asset.id).renderOnWeakDevice
      )
    }

    const skinFor = (asset: GameFieldAsset): SkinConfig | undefined => {
      if (asset.type !== 'bva' && asset.type !== 'smartbva') return undefined
      const base = skinOverrides?.[asset.id] ?? asset.skinConfig
      const local = localSkins[asset.id]
      if (!local) return base
      return {
        ...(base ?? { skin: '' }),
        ...local,
        colors: { ...base?.colors, ...local.colors },
      }
    }

    /**
     * Masters a smartbva cluster needs, split by tier when it asks for it.
     *
     * Tiers come from each placement's own on-screen scale; with splitting off
     * they collapse to the single tier the largest copy needs.
     */
    const variantsFor = (asset: SmartBvaAssetConfig): SmartSkinVariant[] => {
      // Rastered copies share no shape tree, so tier splitting is wasted.
      if (
        qualityOf(asset.id).rastered ||
        qualityOf(asset.id).canvas ||
        !smartCulling.enabled ||
        qualityOf(asset.id).full
      ) {
        return smartVariants(asset, skinFor(asset))
      }
      const base = asset.scale ?? 1
      const tiers = asset.distribution.map((placement) =>
        cullTierFor(pxPerCanvasUnit * base * (placement.scale ?? 1)),
      )
      return smartVariants(asset, skinFor(asset), tiers)
    }

    /** Largest on-screen scale among the placements one master serves. */
    const maxVariantScale = (
      asset: SmartBvaAssetConfig,
      variant: SmartSkinVariant,
    ): number => {
      const base = asset.scale ?? 1
      let max = 0
      for (const i of variant.placementIndexes) {
        const scale = base * (asset.distribution[i]?.scale ?? 1)
        if (scale > max) max = scale
      }
      return max > 0 ? max : base
    }

    // Every draw carries its own z so a smartbva cluster's copies can sit on
    // either side of another asset, exactly as the source Lottie layered them.
    const draws = useMemo(() => {
      const items: Array<{
        key: string
        zIndex: number
        order: number
        node: FlatAsset
        placementIndex?: number
      }> = []
      let order = 0
      for (const node of flat) {
        const { asset } = node
        if (isContainerAsset(asset) || asset.type === 'sound') continue
        if (asset.type === 'smartbva') {
          asset.distribution.forEach((placement, i) => {
            items.push({
              key: placement.id ?? `${asset.id}#${i}`,
              zIndex: placement.zIndex ?? asset.zIndex ?? 0,
              order: order++,
              node,
              placementIndex: i,
            })
          })
          continue
        }
        items.push({
          key: asset.id,
          zIndex: asset.zIndex ?? 0,
          order: order++,
          node,
        })
      }
      return items.sort((a, b) => a.zIndex - b.zIndex || a.order - b.order)
    }, [flat])

    // Only smartbva placements get a marker: a bva rig is positioned by its
    // baked stage matrix, so its config point is the canvas centre and would
    // ring the middle of the field rather than the character.
    const markers: Array<{ key: string; position: Vec2 }> = []
    if (selectedAssetId) {
      const selected = flat.filter(
        (n) => n.asset.id === selectedAssetId || n.parentId === selectedAssetId,
      )
      for (const { asset } of selected) {
        if (asset.type === 'image' && asset.position) {
          if (asset.id === selectedAssetId && selectedPlacementIndex == null) {
            markers.push({ key: asset.id, position: asset.position })
          }
          continue
        }
        if (asset.type !== 'smartbva') continue
        asset.distribution.forEach((p, i) => {
          if (
            selectedPlacementIndex != null &&
            asset.id === selectedAssetId &&
            i !== selectedPlacementIndex
          ) {
            return
          }
          markers.push({ key: `${asset.id}#${i}`, position: p.position })
        })
      }
    }

    const loading = quality.phase === 'load' && flat.some(({ asset }) => {
      if (!isActive(asset) || !drawsOnWeak(asset)) return false
      if (asset.type === 'bva') return true
      return asset.type === 'smartbva' && asset.distribution.some(
        (placement, i) => placementDrawsOnWeak(asset, placement, i),
      )
    })
    const onReadyRef = useRef(onReady)
    onReadyRef.current = onReady
    useEffect(() => {
      if (!loading) onReadyRef.current?.()
    }, [loading, config])

    return (
      <div className="gamefield-root" ref={fitRef} aria-busy={loading}>
      <div
        className="gamefield-stage"
        style={{ width: fieldSize.w * fit, height: fieldSize.h * fit }}
      >
        <div className="gamefield-defs" aria-hidden="true">
          {flat.flatMap((node) => {
            const { asset } = node
            if (!isActive(asset) || !drawsOnWeak(asset)) return []
            if (asset.type === 'image' && node.canvasOwnerId) {
              const size = asset.size ?? fieldSize
              return [
                <CanvasImageMaster
                  key={`image-${asset.id}`}
                  masterId={`image-${asset.id}`}
                  path={asset.path}
                  size={size}
                />,
              ]
            }
            if (asset.type === 'bva' && node.canvasOwnerId) {
              const culling = cullingFor(asset.id, asset.scale ?? 1)
              return [
                <CanvasRigMaster
                  key={`bva-${asset.id}`}
                  config={asset}
                  masterId={`bva-${asset.id}`}
                  rig={rigs[asset.asset]}
                  state={effectiveState(asset.id)}
                  skinConfig={skinFor(asset)}
                  fps={config.fps}
                  priority={qualityOf(asset.id).priority}
                  visibilityPxPerCanvasUnit={culling.visibilityPx}
                  motionThresholdPx={smartCulling.motionThresholdPx}
                  drawCount={1}
                  onCanvas={(canvas) =>
                    setCanvases((prev) =>
                      prev[asset.id]?.w === canvas.w &&
                      prev[asset.id]?.h === canvas.h
                        ? prev
                        : { ...prev, [asset.id]: canvas },
                    )
                  }
                  onPlayback={(playback) =>
                    registerPlayback(asset.id, playback)
                  }
                />,
              ]
            }
            if (asset.type !== 'smartbva') return []
            const variants = variantsFor(asset)
            return variants
              .filter((variant) =>
                variant.placementIndexes.some((i) => {
                  const placement = asset.distribution[i]
                  return (
                    placement && placementDrawsOnWeak(asset, placement, i)
                  )
                }),
              )
              .map((variant) => {
                const culling = cullingFor(
                  asset.id,
                  maxVariantScale(asset, variant),
                )
                let drawCount = 0
                for (const i of variant.placementIndexes) {
                  const placement = asset.distribution[i]
                  if (
                    placement &&
                    placementDrawsOnWeak(asset, placement, i)
                  ) {
                    drawCount += 1
                  }
                }
                const masterProps = {
                  config: asset,
                  masterId: variant.masterId,
                  rig: rigs[asset.asset],
                  state: effectiveState(asset.id),
                  skinConfig: variant.skin,
                  fps: config.fps,
                  priority: qualityOf(asset.id).priority,
                  visibilityPxPerCanvasUnit: culling.visibilityPx,
                  motionThresholdPx: smartCulling.motionThresholdPx,
                  drawCount,
                  onCanvas:
                    variant.index === 0
                      ? (canvas: { w: number; h: number }) =>
                          setCanvases((prev) =>
                            prev[asset.id]?.w === canvas.w &&
                            prev[asset.id]?.h === canvas.h
                              ? prev
                              : { ...prev, [asset.id]: canvas },
                          )
                      : undefined,
                  onPlayback:
                    variant.index === 0
                      ? (playback: RigPlayback | null) =>
                          registerPlayback(asset.id, playback)
                      : undefined,
                }
                const quality = qualityOf(asset.id)
                if (quality.canvas) {
                  return <CanvasRigMaster key={variant.masterId} {...masterProps} />
                }
                if (quality.rastered) {
                  return <RasteredSmartBvaMaster key={variant.masterId} {...masterProps} />
                }
                return (
                  <SmartBvaMaster
                    key={variant.masterId}
                    {...masterProps}
                    fieldSize={fieldSize}
                    cullScale={culling.cullScale}
                    cullThresholdPx={culling.cullThresholdPx}
                  />
                )
              })
          })}
        </div>

        {(() => {
          const nodes: ReactNode[] = []
          let surface: CanvasSurfaceEntry[] = []
          let surfaceOwner: string | null = null
          let surfaceZ = 0
          let surfaceKey = ''
          const flushSurface = () => {
            if (!surface.length) return
            const owner = surfaceOwner ? canvasById.get(surfaceOwner) : undefined
            const surfaceDpr = owner?.maxDpr != null
              ? Math.min(dpr, owner.maxDpr)
              : dpr
            nodes.push(
              <CanvasSurface
                key={surfaceKey}
                surfaceKey={surfaceKey}
                zIndex={surfaceZ}
                entries={surface}
                fit={fit}
                dpr={surfaceDpr}
                poseCache={owner?.poseCache ?? fieldPoseCache}
                repaint={owner?.repaint ?? 'dirty'}
              />,
            )
            surface = []
            surfaceOwner = null
          }

          const ranges = new Map<string, { min: number; max: number }>()
          for (const draw of draws) {
            const owner = draw.node.canvasOwnerId
            if (!owner) continue
            const z = draw.zIndex
            const prev = ranges.get(owner)
            if (!prev) ranges.set(owner, { min: z, max: z })
            else {
              prev.min = Math.min(prev.min, z)
              prev.max = Math.max(prev.max, z)
            }
          }
          for (const draw of draws) {
            if (draw.node.canvasOwnerId) continue
            for (const [owner, range] of ranges) {
              if (draw.zIndex > range.min && draw.zIndex < range.max) {
                console.warn(
                  `[GameField] draw "${draw.key}" z=${draw.zIndex} sits inside canvas "${owner}" z-range ${range.min}–${range.max}. A canvas surface occupies one stacking slot; move the draw or split the canvas.`,
                )
              }
            }
          }

          for (const draw of draws) {
            const { asset } = draw.node
            if (!isActive(asset)) continue
            if (!drawsOnWeak(asset) && asset.type !== 'smartbva') continue

            if (asset.type === 'html') {
              flushSurface()
              nodes.push(
                <div key={draw.key} className="gamefield-draw" data-asset={asset.id}
                  style={{ ...canvasPlacement(
                    asset.position ?? [fieldSize.w / 2, fieldSize.h / 2],
                    asset.size, asset.scale ?? 1, asset.mirror, fit,
                  ), zIndex: draw.zIndex }}>
                  {slots?.[asset.id]}
                </div>,
              )
              continue
            }

            const ownerId = draw.node.canvasOwnerId
            if (ownerId) {
              if (asset.type === 'smartbva') {
                const placementIndex = draw.placementIndex ?? 0
                const placement = asset.distribution[placementIndex]
                if (
                  !placement ||
                  !placementDrawsOnWeak(asset, placement, placementIndex)
                ) {
                  continue
                }
                const variants = variantsFor(asset)
                const variant = variants.find((v) =>
                  v.placementIndexes.includes(placementIndex),
                )
                if (surfaceOwner !== ownerId) {
                  flushSurface()
                  surfaceOwner = ownerId
                  surfaceKey = `canvas-${ownerId}-${draw.key}`
                  surfaceZ = draw.zIndex
                }
                surface.push({
                  key: draw.key,
                  sourceId: variant?.masterId ?? smartMasterId(asset.id),
                  placement,
                  canvas: canvases[asset.id] ?? fieldSize,
                  baseScale: asset.scale ?? 1,
                  zIndex: draw.zIndex,
                })
                continue
              }
              if (asset.type === 'bva') {
                const position =
                  asset.position ??
                  ([fieldSize.w / 2, fieldSize.h / 2] as Vec2)
                if (surfaceOwner !== ownerId) {
                  flushSurface()
                  surfaceOwner = ownerId
                  surfaceKey = `canvas-${ownerId}-${draw.key}`
                  surfaceZ = draw.zIndex
                }
                surface.push({
                  key: draw.key,
                  sourceId: `bva-${asset.id}`,
                  placement: {
                    position,
                    scale: asset.scale,
                    mirror: asset.mirror,
                  },
                  canvas: canvases[asset.id] ?? fieldSize,
                  baseScale: 1,
                  zIndex: draw.zIndex,
                })
                continue
              }
              if (asset.type === 'image') {
                const size = asset.size ?? fieldSize
                const position =
                  asset.position ??
                  ([fieldSize.w / 2, fieldSize.h / 2] as Vec2)
                if (surfaceOwner !== ownerId) {
                  flushSurface()
                  surfaceOwner = ownerId
                  surfaceKey = `canvas-${ownerId}-${draw.key}`
                  surfaceZ = draw.zIndex
                }
                surface.push({
                  key: draw.key,
                  sourceId: `image-${asset.id}`,
                  placement: {
                    position,
                    scale: asset.scale,
                    mirror: asset.mirror,
                  },
                  canvas: { w: size.w, h: size.h },
                  baseScale: 1,
                  zIndex: draw.zIndex,
                })
                continue
              }
              continue
            }

            if (asset.type === 'image') {
              flushSurface()
              const size = asset.size ?? fieldSize
              const position =
                asset.position ?? ([fieldSize.w / 2, fieldSize.h / 2] as Vec2)
              nodes.push(
                <div
                  key={draw.key}
                  className="gamefield-draw"
                  data-asset={asset.id}
                  style={{
                    ...canvasPlacement(
                      position,
                      { w: size.w, h: size.h },
                      asset.scale ?? 1,
                      asset.mirror,
                      fit,
                    ),
                    zIndex: draw.zIndex,
                  }}
                >
                  <img
                    src={asset.path}
                    alt=""
                    draggable={false}
                    style={{ width: '100%', height: '100%', display: 'block' }}
                  />
                </div>,
              )
              continue
            }

            if (asset.type === 'bva') {
              flushSurface()
              const culling = cullingFor(asset.id, asset.scale ?? 1)
              nodes.push(
                <BvaAsset
                  key={draw.key}
                  config={asset}
                  rig={rigs[asset.asset]}
                  state={effectiveState(asset.id)}
                  skinConfig={skinFor(asset)}
                  fieldSize={fieldSize}
                  fit={fit}
                  fps={config.fps}
                  zIndex={draw.zIndex}
                  priority={qualityOf(asset.id).priority}
                  cullScale={culling.cullScale}
                  visibilityPxPerCanvasUnit={culling.visibilityPx}
                  cullThresholdPx={culling.cullThresholdPx}
                  motionThresholdPx={smartCulling.motionThresholdPx}
                  onPlayback={(playback) =>
                    registerPlayback(asset.id, playback)
                  }
                />,
              )
              continue
            }

            if (asset.type !== 'smartbva') continue
            const placementIndex = draw.placementIndex ?? 0
            const placement = asset.distribution[placementIndex]
            if (
              !placement ||
              !placementDrawsOnWeak(asset, placement, placementIndex)
            ) {
              continue
            }
            const variants = variantsFor(asset)
            const variant = variants.find((v) =>
              v.placementIndexes.includes(draw.placementIndex ?? 0),
            )
            const masterId = variant?.masterId ?? smartMasterId(asset.id)
            const canvas = canvases[asset.id] ?? fieldSize
            const baseScale = asset.scale ?? 1
            if (qualityOf(asset.id).canvas) {
              if (surfaceOwner !== null && surfaceOwner !== `__legacy`) {
                flushSurface()
              }
              if (!surface.length) {
                surfaceOwner = `__legacy`
                surfaceKey = `canvas-band-${draw.key}`
                surfaceZ = draw.zIndex
              }
              surface.push({
                key: draw.key,
                sourceId: masterId,
                placement,
                canvas,
                baseScale,
                zIndex: draw.zIndex,
              })
              continue
            }
            flushSurface()
            if (qualityOf(asset.id).rastered) {
              const placementScale = (placement.scale ?? 1) * baseScale
              nodes.push(
                <RasteredSmartBvaDraw
                  key={draw.key}
                  masterId={masterId}
                  placement={placement}
                  canvas={canvas}
                  fit={fit}
                  baseScale={baseScale}
                  zIndex={draw.zIndex}
                  pxPerCanvasUnit={pxPerCanvasUnit * placementScale}
                />,
              )
              continue
            }
            nodes.push(
              <SmartBvaDraw
                key={draw.key}
                assetId={asset.id}
                masterId={masterId}
                placement={placement}
                canvas={canvas}
                fieldSize={fieldSize}
                fit={fit}
                baseScale={baseScale}
                zIndex={draw.zIndex}
              />,
            )
          }
          flushSurface()
          return nodes
        })()}

        {markers.length > 0 ? (
          <svg
            className="gamefield-markers"
            width={fieldSize.w * fit}
            height={fieldSize.h * fit}
            viewBox={`0 0 ${fieldSize.w} ${fieldSize.h}`}
            aria-hidden="true"
          >
            {markers.map((marker) => (
              <circle
                key={marker.key}
                cx={marker.position[0]}
                cy={marker.position[1]}
                r={26}
              />
            ))}
          </svg>
        ) : null}
      </div>
      {loading && <BvaLoadingOverlay>{loader}</BvaLoadingOverlay>}
      </div>
    )
  },
)
