import { canvasPlacement } from './layout'
import { useRigPlayer, type RigPlayback } from './useRigPlayer'
import type { BvaAssetConfig, RigSource, SkinConfig } from './types'

export interface BvaAssetProps {
  config: BvaAssetConfig
  rig?: RigSource | null
  state: string
  skinConfig?: SkinConfig
  fieldSize: { w: number; h: number }
  /** Field fit scale, folded into the element size so the SVG rasters true. */
  fit?: number
  fps?: number
  zIndex: number
  /** Resolved cooldown priority (0–1). Defaults to 1. */
  priority?: number
  /** On-screen scale to cull the resolved bundle for; `null` mounts every shape. */
  cullScale?: number | null
  /** Device pixels per canvas unit, for skipping pose writes that move nothing. */
  visibilityPxPerCanvasUnit?: number
  /** Shape culling threshold in device pixels (CSS-pixel setting times DPR). */
  cullThresholdPx?: number
  /** Movement below this many device pixels is not written. */
  motionThresholdPx?: number
  onPlayback?: (playback: RigPlayback | null) => void
}

export function BvaAsset({
  config,
  rig,
  state,
  skinConfig,
  fieldSize,
  fit = 1,
  fps,
  zIndex,
  priority,
  cullScale,
  visibilityPxPerCanvasUnit,
  cullThresholdPx,
  motionThresholdPx,
  onPlayback,
}: BvaAssetProps) {
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
    onPlayback,
  })

  const canvas = motion?.canvas ?? fieldSize
  const position = config.position ?? [fieldSize.w / 2, fieldSize.h / 2]

  return (
    <div
      ref={containerRef}
      className="gamefield-draw"
      data-asset={config.id}
      style={{
        ...canvasPlacement(
          position,
          canvas,
          config.scale ?? 1,
          config.mirror,
          fit,
        ),
        zIndex,
      }}
    />
  )
}
