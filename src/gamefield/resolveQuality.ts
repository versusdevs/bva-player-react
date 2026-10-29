import {
  DEFAULT_CANVAS,
  DEFAULT_FULL,
  DEFAULT_RASTERED,
  DEFAULT_MAX_N,
  DEFAULT_MEASURE_MS,
  DEFAULT_PRIORITY,
  DEFAULT_RENDER_ON_WEAK,
  DEFAULT_SMART_CULLING,
  DEFAULT_SMART_CULLING_THRESHOLD_CSS_PX,
  DEFAULT_SMART_MOTION_THRESHOLD_PX,
  DEFAULT_WEAK_AVG_JS_MS,
  DEFAULT_WEAK_RAF_HZ,
  DEFAULT_WEAK_TOTAL_SKIPS,
  type GameFieldAsset,
  type GameFieldConfig,
  type SmartBvaPlacement,
} from './types'
import { isContainerAsset } from './types'

export interface FieldQualityConfig {
  maxN: number
  measureMs: number
  weakRafHz: number
  weakTotalSkips: number
  weakAvgJsMs: number
}

export interface ResolvedAssetQuality {
  priority: number
  renderOnWeakDevice: boolean
  /** Opted out of resolution-aware culling and motion cutting. */
  full: boolean
  /**
   * Draw this asset from WebP part rasters with CSS transforms. Inherited
   * from the nearest ancestor that sets it; a child's value wins.
   */
  rastered: boolean
  /**
   * Draw this asset into a Canvas2D band instead of per-part `<img>`s.
   * Inherited from the nearest ancestor that sets it; a child's value wins.
   */
  canvas: boolean
  /**
   * Shape culling threshold in CSS pixels for this asset, or `undefined` to
   * use the field's. Inherited from the nearest ancestor that sets one.
   */
  cullThresholdCssPx: number | undefined
}

/** Field-level resolution-aware culling knobs with defaults applied. */
export interface SmartCullingConfig {
  enabled: boolean
  /** Shape culling threshold in CSS pixels; scale by the DPR to get device pixels. */
  cullThresholdCssPx: number
  /** Motion epsilon threshold, already in device pixels. */
  motionThresholdPx: number
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0 ? value : fallback
}

export function resolveSmartCulling(
  config: GameFieldConfig,
): SmartCullingConfig {
  return {
    enabled: config.smartCulling ?? DEFAULT_SMART_CULLING,
    cullThresholdCssPx: positiveOr(
      config.smartCullingThresholdCssPx,
      DEFAULT_SMART_CULLING_THRESHOLD_CSS_PX,
    ),
    motionThresholdPx: positiveOr(
      config.smartMotionThresholdPx,
      DEFAULT_SMART_MOTION_THRESHOLD_PX,
    ),
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function clampNonNegInt(n: number, fallback: number): number {
  if (!Number.isFinite(n) || n < 0) return fallback
  return Math.round(n)
}

/** Field-level cooldown / measure knobs with defaults applied. */
export function resolveFieldQuality(config: GameFieldConfig): FieldQualityConfig {
  return {
    maxN: clampNonNegInt(config.maxN ?? DEFAULT_MAX_N, DEFAULT_MAX_N),
    measureMs: clampNonNegInt(
      config.measureMs ?? DEFAULT_MEASURE_MS,
      DEFAULT_MEASURE_MS,
    ),
    weakRafHz:
      config.weakRafHz != null && config.weakRafHz > 0
        ? config.weakRafHz
        : DEFAULT_WEAK_RAF_HZ,
    weakTotalSkips: clampNonNegInt(
      config.weakTotalSkips ?? DEFAULT_WEAK_TOTAL_SKIPS,
      DEFAULT_WEAK_TOTAL_SKIPS,
    ),
    weakAvgJsMs:
      config.weakAvgJsMs != null && config.weakAvgJsMs > 0
        ? config.weakAvgJsMs
        : DEFAULT_WEAK_AVG_JS_MS,
  }
}

function inheritPriority(
  asset: GameFieldAsset,
  parent: number | undefined,
): number {
  if (asset.priority != null && Number.isFinite(asset.priority)) {
    return clamp01(asset.priority)
  }
  if (parent != null) return parent
  return DEFAULT_PRIORITY
}

function inheritRenderOnWeak(
  asset: GameFieldAsset,
  parent: boolean | undefined,
): boolean {
  if (asset.renderOnWeakDevice != null) return asset.renderOnWeakDevice
  if (parent != null) return parent
  return DEFAULT_RENDER_ON_WEAK
}

function inheritFull(
  asset: GameFieldAsset,
  parent: boolean | undefined,
): boolean {
  if (asset.full != null) return asset.full
  if (parent != null) return parent
  return DEFAULT_FULL
}

function inheritRastered(
  asset: GameFieldAsset,
  parent: boolean | undefined,
  forced: boolean,
): boolean {
  if (forced || asset.type === 'canvas') return true
  if (asset.rastered != null) return asset.rastered
  if (parent != null) return parent
  return DEFAULT_RASTERED
}

function inheritCanvas(
  asset: GameFieldAsset,
  parent: boolean | undefined,
  forced: boolean,
): boolean {
  if (forced || asset.type === 'canvas') return true
  if (asset.canvas != null) return asset.canvas
  if (parent != null) return parent
  return DEFAULT_CANVAS
}

/**
 * Unlike the others this has no constant default: `undefined` means "whatever
 * the field says", which is resolved at the point of use so a field-level edit
 * still reaches every asset that never overrode it.
 */
function inheritCullThreshold(
  asset: GameFieldAsset,
  parent: number | undefined,
): number | undefined {
  const own = asset.smartCullingThresholdCssPx
  if (own != null && Number.isFinite(own) && own > 0) return own
  return parent
}

/**
 * Walk the asset tree and resolve cooldown flags.
 *
 * - Child `priority` / `renderOnWeakDevice` / `full` / `rastered` / `canvas`
 *   win over the parent group, except under a `type: "canvas"` ancestor,
 *   which forces rastered + canvas and children cannot opt out.
 * - SmartBVA priority is the cluster's (or inherited group); placements
 *   cannot override it.
 * - SmartBVA `renderOnWeakDevice` on a placement wins over the cluster.
 */
export function resolveAssetQuality(
  assets: GameFieldAsset[],
  parentPriority?: number,
  parentRender?: boolean,
  parentFull?: boolean,
  parentCullThreshold?: number,
  parentRastered?: boolean,
  parentCanvas?: boolean,
  forcedCanvas = false,
): Map<string, ResolvedAssetQuality> {
  const out = new Map<string, ResolvedAssetQuality>()
  for (const asset of assets) {
    const priority = inheritPriority(asset, parentPriority)
    const renderOnWeakDevice = inheritRenderOnWeak(asset, parentRender)
    const full = inheritFull(asset, parentFull)
    const rastered = inheritRastered(asset, parentRastered, forcedCanvas)
    const canvas = inheritCanvas(asset, parentCanvas, forcedCanvas)
    const cullThresholdCssPx = inheritCullThreshold(asset, parentCullThreshold)
    out.set(asset.id, {
      priority,
      renderOnWeakDevice,
      full,
      rastered,
      canvas,
      cullThresholdCssPx,
    })
    if (isContainerAsset(asset)) {
      const nested = resolveAssetQuality(
        asset.items,
        priority,
        renderOnWeakDevice,
        full,
        cullThresholdCssPx,
        rastered,
        canvas,
        forcedCanvas || asset.type === 'canvas',
      )
      for (const [id, value] of nested) out.set(id, value)
    }
  }
  return out
}

/** Placement hide flag: placement wins over the already-resolved cluster. */
export function resolvePlacementRenderOnWeak(
  placement: SmartBvaPlacement,
  clusterRenderOnWeak: boolean,
): boolean {
  return placement.renderOnWeakDevice ?? clusterRenderOnWeak
}

/** Pose writes to skip between draws: `round(N * (1 - priority))`. */
export function effectiveSkipN(fieldN: number, priority: number): number {
  if (fieldN <= 0) return 0
  const n = Math.round(fieldN * (1 - clamp01(priority)))
  return n > 0 ? n : 0
}

export function placementQualityKey(
  assetId: string,
  placementIndex: number,
): string {
  return `${assetId}#${placementIndex}`
}
