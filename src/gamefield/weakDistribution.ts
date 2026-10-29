import {
  placementQualityKey,
  resolvePlacementRenderOnWeak,
  type ResolvedAssetQuality,
} from './resolveQuality'
import { isContainerAsset, type GameFieldAsset } from './types'

export interface WeakDistributionCulls {
  hiddenAssetIds: Set<string>
  hiddenPlacementKeys: Set<string>
}

export const EMPTY_WEAK_DISTRIBUTION_CULLS: WeakDistributionCulls = {
  hiddenAssetIds: new Set(),
  hiddenPlacementKeys: new Set(),
}

function clamp01(n: number): number {
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

/** How many of `n` items to keep for a 0–1 ratio. `0` keeps none; `1` keeps all. */
export function keepCount(n: number, ratio: number): number {
  const r = clamp01(ratio)
  if (n <= 0 || r <= 0) return 0
  if (r >= 1) return n
  const keep = Math.round(n * r)
  if (keep < 0) return 0
  return keep > n ? n : keep
}

function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic subset: sort by seed+id hash, take the first `keep` ids. */
export function pickStableSubset(
  ids: string[],
  ratio: number,
  seed: string,
): Set<string> {
  const keep = keepCount(ids.length, ratio)
  if (keep >= ids.length) return new Set(ids)
  if (keep <= 0) return new Set()
  const ranked = ids
    .map((id) => ({ id, h: hashString(`${seed}\0${id}`) }))
    .sort((a, b) => a.h - b.h || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return new Set(ranked.slice(0, keep).map((entry) => entry.id))
}

function explicitRatio(asset: GameFieldAsset): number | null {
  const n = asset.weakDeviceDistributionRatio
  if (n == null || !Number.isFinite(n)) return null
  return clamp01(n)
}

function collectDescendantIds(asset: GameFieldAsset, out: Set<string>): void {
  out.add(asset.id)
  if (isContainerAsset(asset)) {
    for (const child of asset.items) collectDescendantIds(child, out)
  }
}

/**
 * Which assets / placements a weak device should drop after
 * `renderOnWeakDevice` has already been applied.
 *
 * Only nodes that set `weakDeviceDistributionRatio` cull. A group drops
 * direct children (and their subtrees); a smartbva drops placements.
 */
export function resolveWeakDistributionCulls(
  assets: GameFieldAsset[],
  qualityMap: Map<string, ResolvedAssetQuality>,
  fieldId: string,
): WeakDistributionCulls {
  const hiddenAssetIds = new Set<string>()
  const hiddenPlacementKeys = new Set<string>()

  const walk = (list: GameFieldAsset[]): void => {
    for (const asset of list) {
      if (hiddenAssetIds.has(asset.id)) continue

      const ratio = explicitRatio(asset)
      if (isContainerAsset(asset) && ratio != null && ratio < 1) {
        const eligible = asset.items.filter((child) => {
          if (child.active === false) return false
          return qualityMap.get(child.id)?.renderOnWeakDevice !== false
        })
        const keep = pickStableSubset(
          eligible.map((child) => child.id),
          ratio,
          `${fieldId}:${asset.id}`,
        )
        for (const child of eligible) {
          if (!keep.has(child.id)) collectDescendantIds(child, hiddenAssetIds)
        }
      }

      if (asset.type === 'smartbva' && ratio != null && ratio < 1) {
        const clusterRender =
          qualityMap.get(asset.id)?.renderOnWeakDevice ?? true
        const eligible: string[] = []
        asset.distribution.forEach((placement, i) => {
          if (resolvePlacementRenderOnWeak(placement, clusterRender)) {
            eligible.push(placementQualityKey(asset.id, i))
          }
        })
        const keep = pickStableSubset(
          eligible,
          ratio,
          `${fieldId}:${asset.id}`,
        )
        for (const key of eligible) {
          if (!keep.has(key)) hiddenPlacementKeys.add(key)
        }
      }

      if (isContainerAsset(asset)) walk(asset.items)
    }
  }

  walk(assets)
  return { hiddenAssetIds, hiddenPlacementKeys }
}
