import { useCallback, useEffect, useRef } from 'react'
import type { BakedVectorPlayer } from '../baked-vector-animation'
import { smartMasterId } from './layout'
import { useRigPlayer, type RigPlayback } from './useRigPlayer'
import type {
  RigSource,
  SkinConfig,
  SmartBvaAssetConfig,
  SmartBvaPlacement,
} from './types'

/**
 * SmartBVA — one rig, one ticker, many draws.
 *
 * A cluster is the same handful of gestures repeated across many placements.
 * Giving every instance its own player would mean re-running the same matrix
 * work per copy, so instead one master rig ticks off-screen and each
 * placement is an `<use>` that mirrors it live.
 */

export interface SmartBvaMasterProps {
  config: SmartBvaAssetConfig
  rig?: RigSource | null
  state: string
  skinConfig?: SkinConfig
  fieldSize: { w: number; h: number }
  fps?: number
  /** Resolved cluster cooldown priority (0–1). Placements cannot override. */
  priority?: number
  /**
   * On-screen scale to cull this master's bundle for; `null` mounts every
   * shape. Must be the scale of the largest copy referencing it.
   */
  cullScale?: number | null
  /** Device pixels per canvas unit for the largest copy referencing this master. */
  visibilityPxPerCanvasUnit?: number
  /** Shape culling threshold in device pixels (CSS-pixel setting times DPR). */
  cullThresholdPx?: number
  /** Movement below this many device pixels is not written. */
  motionThresholdPx?: number
  /** DOM id the draws `<use>`. Defaults to `smartMasterId(config.id)`. */
  masterId?: string
  /**
   * Visible `<use>` copies of this master. The HUD multiplies the master's
   * mounted shapes by this so a still crowd still counts as N drawings.
   */
  drawCount?: number
  onCanvas?: (canvas: { w: number; h: number }) => void
  onPlayback?: (playback: RigPlayback | null) => void
}

/** The off-screen rig every placement of this asset references. */
export function SmartBvaMaster({
  config,
  rig,
  state,
  skinConfig,
  fieldSize,
  fps,
  priority,
  cullScale,
  visibilityPxPerCanvasUnit,
  cullThresholdPx,
  motionThresholdPx,
  masterId,
  drawCount,
  onCanvas,
  onPlayback,
}: SmartBvaMasterProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const resolvedMasterId = masterId ?? smartMasterId(config.id)

  const handleCreated = useCallback(
    (player: BakedVectorPlayer) => {
      const svg = player.getSvg()
      svg.id = resolvedMasterId
      // `<use>` sizes the reference from the svg's width/height attributes;
      // the player's 100% inline sizing would collapse inside the shadow tree.
      svg.style.width = ''
      svg.style.height = ''
      svgRef.current = svg
    },
    [resolvedMasterId],
  )

  const { containerRef, motion } = useRigPlayer({
    asset: config.asset,
    rig,
    skinConfig,
    states: config.states,
    state,
    fps,
    priority,
    cullScale,
    visibilityPxPerCanvasUnit,
    cullThresholdPx,
    motionThresholdPx,
    drawCount,
    onPlayerCreated: handleCreated,
    onPlayback,
  })

  const canvasW = motion?.canvas.w ?? fieldSize.w
  const canvasH = motion?.canvas.h ?? fieldSize.h
  const canvasRef = useRef(onCanvas)
  canvasRef.current = onCanvas

  useEffect(() => {
    const svg = svgRef.current
    if (svg) {
      svg.setAttribute('width', String(canvasW))
      svg.setAttribute('height', String(canvasH))
    }
    canvasRef.current?.({ w: canvasW, h: canvasH })
  }, [canvasW, canvasH, motion])

  return <div ref={containerRef} className="gamefield-master" />
}

export interface SmartBvaDrawProps {
  assetId: string
  placement: SmartBvaPlacement
  canvas: { w: number; h: number }
  fieldSize: { w: number; h: number }
  /**
   * Field fit scale. Applied as the ratio of the SVG's pixel size to its
   * viewBox, so the copy rasterizes at its true on-screen size — a CSS
   * `scale()` here would raster at full size and resample, and the sub-pixel
   * shapes culling removed would have been drawn anyway.
   */
  fit?: number
  baseScale?: number
  zIndex: number
  /** DOM id of the master this copy references. Defaults to `smartMasterId(assetId)`. */
  masterId?: string
}

/**
 * A single live copy of the master rig at its own transform.
 *
 * The box is field-sized on purpose. Sizing each copy to its rig's measured
 * content instead — so `contain: strict` above actually bounds something —
 * measures ~11% *slower* on a throttled Stadium (15.7 fps against 17.6 over
 * three runs each at 20x CPU throttle). Paint invalidation follows the
 * geometry that changed, which was only ever fan-sized, so the roomy box cost
 * nothing; cropping to it instead makes all ~100 copies clip every frame, and
 * the clips cost more than the smaller invalidation rect saves.
 */
export function SmartBvaDraw({
  assetId,
  placement,
  canvas,
  fieldSize,
  fit = 1,
  baseScale = 1,
  zIndex,
  masterId,
}: SmartBvaDrawProps) {
  const scale = (placement.scale ?? 1) * baseScale
  const sx = placement.mirror ? -scale : scale
  const transform =
    `translate(${placement.position[0]}, ${placement.position[1]}) ` +
    `scale(${sx}, ${scale}) translate(${-canvas.w / 2}, ${-canvas.h / 2})`
  const href = `#${masterId ?? smartMasterId(assetId)}`

  return (
    <svg
      className="gamefield-draw"
      style={{ position: 'absolute', left: 0, top: 0, zIndex }}
      width={fieldSize.w * fit}
      height={fieldSize.h * fit}
      viewBox={`0 0 ${fieldSize.w} ${fieldSize.h}`}
      aria-hidden="true"
    >
      <g transform={transform}>
        <use
          href={href}
          width={canvas.w}
          height={canvas.h}
        />
      </g>
    </svg>
  )
}
