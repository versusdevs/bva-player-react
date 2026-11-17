import type { HapticFeedback } from '../haptics'

/**
 * GameField config shape. A gamefield is a plain JSON scene: a canvas size
 * plus a tree of assets that each map a logical `state` (the name game
 * controls speak) onto a baked motion segment and a timing program.
 */

import type { AssetBundle, MotionData } from '../baked-vector-animation'

/** Canvas-space point, `[x, y]`. Assets are anchored at their centre. */
export type Vec2 = [number, number]

/**
 * One step of a timing program.
 *
 * - `n >= 1` — hold the current frame for `n` frames.
 * - `-1` — stop here (freeze, do not loop).
 * - `"n:m"` — play frames `n` through `m`.
 * - `":"` — play the whole segment. `"n:"` / `":m"` are open-ended forms.
 */
export type TimingStep = number | string

export interface StateDef {
  /** Logical name the controls address, e.g. `idle`, `attack`. */
  state: string
  /** Baked segment this state plays. */
  segment: string
  /** Playback program. Omitted means "play once, then hold the last frame". */
  timing?: TimingStep[]
}

/**
 * Play-time appearance for a bva/smartbva asset.
 *
 * `skin` selects a named layer. Optional `face` / `hair` / `colors` are
 * passed through to `RigSource.buildVariables`. `hideParts` is expanded by
 * `RigSource.buildHiddenParts` (when present) and omitted from the bundle.
 * Extra keys are allowed so an app can feed `prepareBundle` (for example an
 * overlay composited from another rig).
 */
export interface SkinConfig {
  skin: string
  face?: number
  hair?: number
  colors?: {
    hair_color?: string
    face_color?: string
    skin_color?: string
  }
  /**
   * Rig part names (or host-defined group aliases) to drop from the
   * resolved bundle. Missing parts are never mounted, so they are not
   * painted and receive no per-frame motion.
   */
  hideParts?: string[]
  [key: string]: unknown
}

/**
 * How a config `asset` name resolves to baked files.
 * JSON names a rig (`"asset": "hero"`); the host app supplies URLs and hooks.
 */
export interface RigSource {
  motionUrl: string
  layerUrl: string
  buildVariables?: (
    skin?: SkinConfig,
  ) => Record<string, string | number | boolean> | undefined
  /** Expand `skin.hideParts` (aliases → part names). Result is passed to `loadAssetBundle`. */
  buildHiddenParts?: (skin?: SkinConfig) => string[] | undefined
  prepareBundle?: (
    bundle: AssetBundle,
    skin?: SkinConfig,
  ) => AssetBundle | Promise<AssetBundle>
  /**
   * Part names whose bake-time WebP ignores play-time variables. Those
   * parts are re-rasterized from the resolved SVG at load. Empty by default
   * — a host that uses Face / Hairstyle variables supplies those names.
   */
  variableRasterParts?: string[]
  /**
   * Adapt a loaded motion before rendering or culling. Return a new motion;
   * the downloaded data is cached and shared with other rig instances.
   * Keep the callback stable to avoid restarting playback.
   */
  prepareMotion?: (motion: MotionData) => MotionData
}

export const DEFAULT_MAX_N = 4
export const DEFAULT_MEASURE_MS = 1500
export const DEFAULT_WEAK_RAF_HZ = 24
export const DEFAULT_WEAK_TOTAL_SKIPS = 8
export const DEFAULT_WEAK_AVG_JS_MS = 8
export const DEFAULT_PRIORITY = 1
export const DEFAULT_RENDER_ON_WEAK = true
export const DEFAULT_WEAK_DEVICE_DISTRIBUTION_RATIO = 1
export const DEFAULT_FULL = false
export const DEFAULT_RASTERED = false
export const DEFAULT_CANVAS = false
/**
 * Per-surface offscreen blit for canvas rigs: paint each master's pose
 * once, then stamp copies. Default off. Field-level default; a `canvas`
 * asset can override it with `poseCache`.
 */
export const DEFAULT_CANVAS_POSE_CACHE = false
/** @deprecated Use {@link DEFAULT_CANVAS_POSE_CACHE}. */
export const DEFAULT_CANVAS_CROWD_CACHE = DEFAULT_CANVAS_POSE_CACHE
/**
 * How many rastered part `<img>`s may carry `will-change: transform, opacity` before
 * we promote only the placement wrapper instead. Past this, Chrome's layer
 * cap (and the layerization work itself) costs more than compositor-only
 * part writes save.
 */
export const DEFAULT_RASTERED_LAYER_BUDGET = 256
export const DEFAULT_SMART_CULLING = true
/**
 * Shape culling threshold, in CSS pixels.
 *
 * Visibility is a property of the eye, not of the raster grid: on a dpr-3
 * phone one device pixel is a third of a CSS pixel, far below anything a
 * person can resolve, so a device-pixel threshold culls almost nothing there.
 * One CSS pixel is the same apparent size on every display.
 */
export const DEFAULT_SMART_CULLING_THRESHOLD_CSS_PX = 1
/**
 * Motion epsilon threshold, in device pixels.
 *
 * Deliberately not the CSS-pixel threshold above. The eye follows movement
 * well below the size at which it resolves static detail, so collapsing a
 * whole CSS pixel of motion makes near rigs visibly step.
 */
export const DEFAULT_SMART_MOTION_THRESHOLD_PX = 1
export const DEFAULT_SMART_VARIANTS_CULLING = true

interface AssetBase {
  id: string
  name?: string
  /** Centre point in canvas space. Defaults to the canvas centre. */
  position?: Vec2
  zIndex?: number
  scale?: number
  /** Flip horizontally around the asset centre. */
  mirror?: boolean
  /** Shown by default; `false` mounts nothing. */
  active?: boolean
  /** State played on initialization. */
  state?: string
  states?: StateDef[]
  /**
   * 0–1. How much pose-skip cooldown this asset absorbs. `1` (default) never
   * skips; `0` takes the full field N. A child's value wins over its group.
   * SmartBVA placements cannot override the cluster priority.
   */
  priority?: number
  /**
   * When the field is classified weak after measuring, `false` unmounts this
   * asset (or placement). Default `true`. A child's value wins over its group;
   * a SmartBVA placement wins over the cluster.
   */
  renderOnWeakDevice?: boolean
  /**
   * 0–1. On a weak device, keep this fraction of this node's direct contents.
   * `1` (default / unset) shows all. A group applies it to child assets; a
   * smartbva applies it to `distribution` placements. Not inherited — only
   * the node that sets it culls.
   */
  weakDeviceDistributionRatio?: number
  /**
   * Render this asset at full fidelity: no resolution-aware shape culling and
   * no motion cutting, however small it is drawn. Default `false`. A child's
   * value wins over its group, so a group can opt a whole subtree in and one
   * item back out. Use it for anything the player looks straight at.
   */
  full?: boolean
  /**
   * Draw animatable parts from the bake-time WebP sidecar and drive them
   * with CSS `transform` instead of SVG markup. Default `false`. A child's
   * value wins over its group, so a group can raster a whole subtree and
   * one item back out. SmartBVA placements cannot override the cluster —
   * every copy of a rastered cluster shares one ticker.
   *
   * Parts with per-frame fill/stroke changes stay on the vector path (a
   * WebP cannot be recolored). This pass only acts on `smartbva` unless
   * the asset sits under a `type: "canvas"` ancestor, which forces it.
   */
  rastered?: boolean
  /**
   * Draw this smartbva cluster into a Canvas2D surface instead of per-part
   * `<img>` elements. Implies raster sources. Default `false`. A child's
   * value wins over its group. SmartBVA placements cannot override the
   * cluster. Prefer a `type: "canvas"` ancestor for mixed subtrees.
   *
   * Without a canvas ancestor, GameField still splits canvas-flagged
   * smartbva draws into z-contiguous bands so static assets interleaved
   * between copies keep their stacking order.
   */
  canvas?: boolean
  /**
   * Shape culling threshold for this asset in CSS pixels, overriding the
   * field's {@link GameFieldConfig.smartCullingThresholdCssPx}. A child's
   * value wins over its group, so a group can coarsen a whole subtree and one
   * item back out of it. Ignored when `full` is set, which culls nothing.
   *
   * Raise it on background clusters the player never looks at directly; leave it
   * at the field default for anything in the foreground.
   */
  smartCullingThresholdCssPx?: number
}

export interface ImageAssetConfig extends AssetBase {
  type: 'image'
  path: string
  /** Rendered size in canvas units. Defaults to the image's natural size. */
  size?: { w: number; h: number }
}

/** Host-owned DOM content positioned in scene coordinates. */
export interface HtmlAssetConfig extends AssetBase {
  type: 'html'
  size: { w: number; h: number }
}

export interface BvaAssetConfig extends AssetBase {
  type: 'bva'
  /** Name looked up in the `rigs` map passed to `<GameField>`. */
  asset: string
  skinConfig?: SkinConfig
}

export interface SmartBvaPlacement {
  id?: string
  position: Vec2
  zIndex?: number
  scale?: number
  mirror?: boolean
  /** Merged over the cluster `skinConfig` (e.g. a distant-row LOD). */
  skinConfig?: Partial<SkinConfig>
  /**
   * Wins over the cluster / group `renderOnWeakDevice`. Priority is not
   * accepted here — the cluster owns skip cadence.
   */
  renderOnWeakDevice?: boolean
}

export interface SmartBvaAssetConfig extends AssetBase {
  type: 'smartbva'
  asset: string
  skinConfig?: SkinConfig
  /** Every placement draws the same ticking rig at its own transform. */
  distribution: SmartBvaPlacement[]
  /**
   * Split this cluster into one master per culling tier. Default `true`.
   *
   * One master ticks for every copy that references it, so its culling has to
   * suit the largest copy — in a cluster spanning several scales the small
   * copies then get no benefit. Splitting groups placements by tier and gives
   * each group its own master, culled for its own size. The cost is one extra
   * ticking rig per tier, which is a handful of matrix writes; set `false` to
   * trade the culling back for that.
   */
  smartVariantsCulling?: boolean
}

export interface GroupAssetConfig extends AssetBase {
  type: 'group'
  items: GameFieldAsset[]
}

/**
 * A group that rasterizes its subtree into one Canvas2D surface.
 * Legal anywhere a group is legal. Children cannot opt out of raster/canvas.
 * A nested `canvas` wins for its own subtree and gets a separate surface.
 */
export interface CanvasAssetConfig extends AssetBase {
  type: 'canvas'
  items: GameFieldAsset[]
  /** `dirty` (default) repaints changed regions only; `full` clears the surface. */
  repaint?: 'dirty' | 'full'
  /** Cap the backing-store scale. Defaults to the device dpr. */
  maxDpr?: number
  /**
   * Paint each rig's pose once into an offscreen bitmap and blit the copies.
   * Defaults to the field-level `canvasPoseCache`, which defaults to false.
   */
  poseCache?: boolean
}

export type SoundChannel = 'bg' | 'sfx'

export type SoundTrigger = 'state' | 'manual'

/** One clip in a named cue sequence. `at` is a delay in ms from the cue start. */
export interface SoundCueStep {
  clip: string
  at?: number
  volume?: number
}

/**
 * Logical state → clip for a sound asset. Omit `clip` for silence
 * (e.g. oneshot `idle` that should not fire).
 */
export interface SoundStateDef {
  state: string
  /** Key in the host `clips` map, or a URL if that key is missing. */
  clip?: string
  /** 0..1. Default 1. */
  volume?: number
  /** Overrides the asset `loop` for this state. */
  loop?: boolean
}

/**
 * A headless audio asset. Follows `effectiveState` like a visual, or plays
 * only when the host calls `playSound`. Position / zIndex / culling / pose-skip
 * are ignored. `active: false` and `renderOnWeakDevice: false` mute.
 */
export interface SoundAssetConfig extends Omit<AssetBase, 'states'> {
  type: 'sound'
  states?: SoundStateDef[]
  /** Default clip when there is no matching state (manual SFX). */
  clip?: string
  /** 0..1. Default 1. */
  volume?: number
  /** True = looping bed, exclusive per asset id. Default false. */
  loop?: boolean
  /**
   * `state` (default) follows effectiveState (own, or parent if nested).
   * `manual` ignores parent; only `playSound` / cues play.
   */
  trigger?: SoundTrigger
  /** Default: `loop ? 'bg' : 'sfx'`. Host `bgEnabled` / `sfxEnabled` gate these. */
  channel?: SoundChannel
  /** Named one-shot sequences. `playSound(id, name)` runs the list. */
  cues?: Record<string, SoundCueStep[]>
}

export type GameFieldAsset =
  | HtmlAssetConfig
  | ImageAssetConfig
  | BvaAssetConfig
  | SmartBvaAssetConfig
  | GroupAssetConfig
  | CanvasAssetConfig
  | SoundAssetConfig

export function isContainerAsset(
  asset: GameFieldAsset,
): asset is GroupAssetConfig | CanvasAssetConfig {
  return asset.type === 'group' || asset.type === 'canvas'
}

export interface GameFieldConfig {
  id: string
  name: string
  size: { w: number; h: number }
  /** Available background beyond the original scene, in scene coordinates. */
  artworkBounds?: { x: number; y: number; w: number; h: number }
  /** Timing programs count in these frames. Defaults to each motion's own fps. */
  fps?: number
  /** Cap on field-level pose-skip N. Defaults to {@link DEFAULT_MAX_N}. */
  maxN?: number
  /** Measuring-phase length in ms. Defaults to {@link DEFAULT_MEASURE_MS}. */
  measureMs?: number
  /** Weak if average rAF Hz is below this. Defaults to {@link DEFAULT_WEAK_RAF_HZ}. */
  weakRafHz?: number
  /**
   * Weak if the sum of catch-up jumps during measure is at least this.
   * Defaults to {@link DEFAULT_WEAK_TOTAL_SKIPS}.
   */
  weakTotalSkips?: number
  /** Weak if average JS work exceeds this (ms). Defaults to {@link DEFAULT_WEAK_AVG_JS_MS}. */
  weakAvgJsMs?: number
  /**
   * Master switch for resolution-aware work skipping: dropping shapes that
   * cover less than a pixel at the size they are drawn, and skipping pose
   * writes that move no pixel. Defaults to {@link DEFAULT_SMART_CULLING}
   * (on). Assets marked `full` opt out individually.
   */
  smartCulling?: boolean
  /**
   * How small a shape has to be, in CSS pixels, to count as invisible and be
   * dropped. Multiplied by the device pixel ratio before it reaches the
   * culler. Defaults to {@link DEFAULT_SMART_CULLING_THRESHOLD_CSS_PX}.
   */
  smartCullingThresholdCssPx?: number
  /**
   * How far a part has to move, in device pixels, before the pose write is
   * worth issuing. Defaults to {@link DEFAULT_SMART_MOTION_THRESHOLD_PX}.
   * Raising this past about 2 makes near rigs step visibly.
   */
  smartMotionThresholdPx?: number
  /**
   * Default pose-cache for canvas surfaces that do not set `poseCache`.
   * Paint each master's pose once into an offscreen bitmap and blit copies.
   * Default {@link DEFAULT_CANVAS_POSE_CACHE} (off).
   */
  canvasPoseCache?: boolean
  /** @deprecated Use {@link GameFieldConfig.canvasPoseCache}. */
  canvasCrowdCache?: boolean
  assets: GameFieldAsset[]
}

export function resolveCanvasPoseCache(config: GameFieldConfig): boolean {
  return config.canvasPoseCache ?? config.canvasCrowdCache ?? DEFAULT_CANVAS_POSE_CACHE
}

export interface GameFieldHandle {
  /** Set the logical state of an asset (or every item of a group). */
  setAssetState: (id: string, state: string) => void
  getAssetState: (id: string) => string | null
  setAssetActive: (id: string, active: boolean) => void
  /** Overlay a skin patch on a bva/smartbva asset. Wins over host overrides. */
  setAssetSkin: (id: string, patch: Partial<SkinConfig>) => void
  /** Length of a state's segment in ms, or 0 when unknown/looping forever. */
  getStateDurationMs: (id: string, state: string) => number
  /**
   * Play a manual sound asset. With `cue`, runs that named sequence
   * (`at` delays in ms). Without, plays the asset `clip`.
   */
  playSound: (id: string, cue?: string) => void
  /** Stop looping / in-flight clips for this sound asset, including pending cues. */
  stopSound: (id: string) => void
  /** Play mobile haptics from a user gesture, independently of audio mute. */
  playHaptic: HapticFeedback['play']
  /** Cancel the current pattern, including any delayed impacts. */
  stopHaptics: () => void
}
