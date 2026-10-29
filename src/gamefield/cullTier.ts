/**
 * Culling tiers: turning a rig's on-screen scale into a small, stable set of
 * buckets, and each bucket into the per-part thresholds that drive shape
 * culling and the motion epsilon.
 *
 * Quantizing matters for two reasons. Resolved bundles are cached by their
 * options, so a threshold map that varied with every placement's exact scale
 * would give every copy its own cache entry and its own serialize pass. And a
 * tier change forces a bundle re-resolve plus a full `rebuildParts`, so tiers
 * have to be coarse enough that a window resize rarely crosses one.
 *
 * Tiers are powers of two, and each tier's representative scale is the top of
 * its range. That bias is deliberate: the representative is always at least
 * the real scale, so the derived threshold is never larger than the ideal one
 * and the culling never removes something that was actually visible.
 *
 * Tiers are deliberately coarse because crossing one re-groups the masters a
 * crowd draws from. Thresholds do not need that coarseness — they only key a
 * bundle cache entry — so they quantize on the finer ladder in
 * {@link cullScaleFor}. Rounding a real 0.38 up to a tier's 0.5 would throw
 * away a third of the threshold and, with it, most of the culling.
 */

import type { Matrix6, MotionData } from '../baked-vector-animation'

/** Keeps a degenerate scale from producing an absurd tier. */
const MIN_TIER = -4
const MAX_TIER = 8

function matrixScale(m: Matrix6): number {
  return Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]))
}

/**
 * Bucket a device-pixels-per-canvas-unit scale into a tier index.
 *
 * Tier 0 is "drawn at native size or larger", and each step up halves the
 * scale. Negative tiers cover high-DPR displays drawing larger than native.
 */
export function cullTierFor(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 0
  const tier = Math.floor(-Math.log2(scale))
  if (tier < MIN_TIER) return MIN_TIER
  if (tier > MAX_TIER) return MAX_TIER
  return tier
}

/**
 * Representative scale for a tier: the top of its range, so it is always at
 * least as large as any real scale that maps to this tier.
 */
export function tierScale(tier: number): number {
  return Math.pow(2, -tier)
}

/**
 * Quantization steps per halving of scale for culling thresholds. Eight steps
 * put the representative scale within ~9% of the real one, against the 100% a
 * whole tier allows, while still collapsing a resize drag onto a handful of
 * cache entries rather than one per pixel.
 */
const SCALE_STEPS_PER_OCTAVE = 8

/**
 * Representative scale for culling thresholds: `scale` rounded up onto a
 * geometric ladder.
 *
 * Rounding up keeps the same guarantee {@link tierScale} gives — the
 * representative is never smaller than the real scale, so a threshold derived
 * from it never removes something still visible — but overshoots by at most
 * `2 ** (1 / SCALE_STEPS_PER_OCTAVE)` instead of by up to a full tier.
 */
export function cullScaleFor(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 0
  const steps = Math.floor(-Math.log2(scale) * SCALE_STEPS_PER_OCTAVE)
  const lo = MIN_TIER * SCALE_STEPS_PER_OCTAVE
  const hi = MAX_TIER * SCALE_STEPS_PER_OCTAVE
  const clamped = steps < lo ? lo : steps > hi ? hi : steps
  return Math.pow(2, -clamped / SCALE_STEPS_PER_OCTAVE)
}

/** The tier a whole cluster must use: the one its largest copy needs. */
export function clusterTier(tiers: readonly number[]): number {
  let min = 0
  let seen = false
  for (const tier of tiers) {
    if (!seen || tier < min) {
      min = tier
      seen = true
    }
  }
  return seen ? min : 0
}

/**
 * Largest scale each part's matrix ever applies, keyed by asset name.
 *
 * Culling compares a shape's size in its part's local units, but the part
 * matrix scales those units on their way to the stage. Taking the maximum
 * across every frame of every segment means a part that is small at rest but
 * grows mid-animation is measured at its largest, which under-culls rather
 * than over-culls.
 *
 * Cached per motion object, so a crowd sharing one `.bva` computes it once.
 */
const partScaleCache = new WeakMap<MotionData, Record<string, number>>()

export function motionPartScales(motion: MotionData): Record<string, number> {
  const cached = partScaleCache.get(motion)
  if (cached) return cached
  const out: Record<string, number> = {}
  for (const segment of Object.values(motion.segments)) {
    for (const part of segment.parts) {
      let max = out[part.asset] ?? 0
      for (const m of part.matrices) {
        const s = matrixScale(m)
        if (s > max) max = s
      }
      out[part.asset] = max
    }
  }
  partScaleCache.set(motion, out)
  return out
}

/** Largest scale factor the stage matrix applies. */
export function motionStageScale(motion: MotionData): number {
  const scale = matrixScale(motion.stage)
  return scale > 0 ? scale : 1
}

/**
 * Per-part culling thresholds in local units, at one on-screen scale.
 *
 * `scale` is device pixels per canvas unit for the rig — for a SmartBVA master,
 * its largest copy's — already quantized by {@link cullScaleFor} so copies
 * share a bundle. A shape's local unit reaches `scale * stageScale * partScale`
 * device pixels, so a shape is invisible once its extent falls under
 * `thresholdPx / that`. Parts whose scale is unknown or zero get `0`, which
 * disables culling for them rather than culling everything.
 */
export function cullThresholdsFor(
  motion: MotionData,
  scale: number,
  thresholdPx: number,
): Record<string, number> {
  const perCanvasUnit = scale * motionStageScale(motion)
  const partScales = motionPartScales(motion)
  const out: Record<string, number> = {}
  for (const [name, partScale] of Object.entries(partScales)) {
    const perLocalUnit = perCanvasUnit * partScale
    out[name] = perLocalUnit > 0 ? thresholdPx / perLocalUnit : 0
  }
  return out
}
