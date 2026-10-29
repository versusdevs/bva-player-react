import type { CSSProperties } from 'react'
import { clusterTier } from './cullTier'
import { DEFAULT_SMART_VARIANTS_CULLING } from './types'
import type {
  GameFieldAsset,
  GameFieldConfig,
  SkinConfig,
  SmartBvaAssetConfig,
  Vec2,
} from './types'
import { isContainerAsset } from './types'

export interface FlatAsset {
  asset: GameFieldAsset
  parentId: string | null
  depth: number
  /** Nearest `type: "canvas"` ancestor, if any. */
  canvasOwnerId: string | null
}

/** Depth-first walk of the asset tree, parents before their items. */
export function flattenAssets(
  assets: GameFieldAsset[],
  parentId: string | null = null,
  depth = 0,
  canvasOwnerId: string | null = null,
): FlatAsset[] {
  const out: FlatAsset[] = []
  for (const asset of assets) {
    out.push({ asset, parentId, depth, canvasOwnerId })
    if (isContainerAsset(asset)) {
      const nextOwner = asset.type === 'canvas' ? asset.id : canvasOwnerId
      out.push(...flattenAssets(asset.items, asset.id, depth + 1, nextOwner))
    }
  }
  return out
}

export function findFieldAsset(
  config: GameFieldConfig | null,
  id: string | null,
): GameFieldAsset | null {
  if (!config || !id) return null
  const walk = (assets: GameFieldAsset[]): GameFieldAsset | null => {
    for (const asset of assets) {
      if (asset.id === id) return asset
      if (isContainerAsset(asset)) {
        const hit = walk(asset.items)
        if (hit) return hit
      }
    }
    return null
  }
  return walk(config.assets)
}

/**
 * Place a rig canvas so its centre lands on `position`, at `scale` and the
 * field's `fit`. Baked motions carry their own `#stage` matrix, so a rig only
 * needs to be moved as a whole — never re-laid-out internally.
 *
 * Both scales are folded into the element's width and height rather than left
 * in a CSS `scale()`. The child is an SVG sized `100%` over a canvas-unit
 * viewBox, so this makes the browser rasterize it at its true on-screen size:
 * a shape that ends up under a pixel is under a pixel to the rasterizer too,
 * which is what lets resolution-aware culling pay off. A CSS `scale()` instead
 * rasterizes at the pre-scale size and resamples, so the sub-pixel detail is
 * drawn in full and then thrown away.
 *
 * Mirroring stays a transform: `scaleX(-1)` flips without changing size, so it
 * does not affect the raster scale.
 */
export function canvasPlacement(
  position: Vec2,
  canvas: { w: number; h: number },
  scale = 1,
  mirror = false,
  fit = 1,
): CSSProperties {
  const w = canvas.w * scale * fit
  const h = canvas.h * scale * fit
  return {
    position: 'absolute',
    left: 0,
    top: 0,
    width: w,
    height: h,
    transformOrigin: 'center center',
    transform:
      `translate(${position[0] * fit - w / 2}px, ${position[1] * fit - h / 2}px)` +
      (mirror ? ' scaleX(-1)' : ''),
  }
}

/** DOM id of a smartbva master rig, referenced by each of its draws. */
export function smartMasterId(assetId: string, variantIndex = 0): string {
  return variantIndex === 0
    ? `smartbva-${assetId}`
    : `smartbva-${assetId}-v${variantIndex}`
}

/** Merge a placement/host overlay onto a cluster `skinConfig`. */
export function mergeSkinConfig(
  base: SkinConfig | undefined,
  overlay?: Partial<SkinConfig> | null,
): SkinConfig | undefined {
  if (!overlay) return base
  const keys = Object.keys(overlay)
  if (keys.length === 0) return base
  const skin = overlay.skin ?? base?.skin
  if (!skin) return overlay as SkinConfig
  return {
    ...(base ?? { skin }),
    ...overlay,
    skin,
    colors: { ...base?.colors, ...overlay.colors },
    hideParts: overlay.hideParts ?? base?.hideParts,
  }
}

export interface SmartSkinVariant {
  index: number
  masterId: string
  skin: SkinConfig | undefined
  placementIndexes: number[]
  /**
   * Culling tier this master is built for. Without per-tier splitting this is
   * the whole cluster's tier — the one its largest copy needs.
   */
  tier: number
}

function skinConfigKey(skin: SkinConfig | undefined): string {
  return JSON.stringify(skin ?? null)
}

/**
 * Group a smartbva cluster's placements into the masters they can share. The
 * variant that matches the cluster skin keeps `smartMasterId(asset.id)` so
 * fields without per-placement overlays are unchanged.
 *
 * Placements always group by resolved skin. When `smartVariantsCulling` is on
 * (the default) and `placementTiers` is supplied, they also group by culling
 * tier, so each tier gets a master culled for its own size instead of every
 * copy sharing one built for the largest. Without splitting, all placements
 * share the cluster tier — the one its largest copy needs.
 */
export function smartVariants(
  asset: SmartBvaAssetConfig,
  baseSkin: SkinConfig | undefined,
  placementTiers?: readonly number[] | null,
): SmartSkinVariant[] {
  const splitByTier =
    (asset.smartVariantsCulling ?? DEFAULT_SMART_VARIANTS_CULLING) &&
    !!placementTiers
  const sharedTier = placementTiers ? clusterTier(placementTiers) : 0

  const groups = new Map<
    string,
    { skin: SkinConfig | undefined; indexes: number[]; tier: number }
  >()
  const order: string[] = []
  for (let i = 0; i < asset.distribution.length; i++) {
    const merged = mergeSkinConfig(baseSkin, asset.distribution[i].skinConfig)
    const skinKey = skinConfigKey(merged)
    const tier = splitByTier ? (placementTiers![i] ?? sharedTier) : sharedTier
    const key = splitByTier ? `${skinKey}\0${tier}` : skinKey
    let group = groups.get(key)
    if (!group) {
      group = { skin: merged, indexes: [], tier }
      groups.set(key, group)
      order.push(key)
    }
    group.indexes.push(i)
  }

  // The cluster's own skin at the cluster tier keeps variant index 0 so its
  // master id, and every `<use href>` pointing at it, stay as they were.
  const baseKey = splitByTier
    ? `${skinConfigKey(baseSkin)}\0${sharedTier}`
    : skinConfigKey(baseSkin)
  const hasBase = groups.has(baseKey)
  let next = hasBase ? 1 : 0
  return order.map((key) => {
    const group = groups.get(key)!
    const index = hasBase && key === baseKey ? 0 : next++
    return {
      index,
      masterId: smartMasterId(asset.id, index),
      skin: group.skin,
      placementIndexes: group.indexes,
      tier: group.tier,
    }
  })
}
