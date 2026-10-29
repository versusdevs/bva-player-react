/**
 * One requestAnimationFrame loop for every timing-driven rig on a field.
 *
 * Rigs are advanced by whole frames from a single clock so a crowd of
 * instances stays phase-locked, and so a field with dozens of draws still
 * wakes the browser only once per frame.
 *
 * The loop always samples cheap counters (rAF interval, catch-up jump, JS
 * work). Those stay in module memory for later quality scaling; React is
 * never touched from here.
 */

import {
  beginTickSkips,
  getFieldN,
  getQualityPhase,
  isFieldWeak,
  takeTickSkips,
  tickQuality,
  type QualityPhase,
} from './fieldQuality'

export type FrameFn = (frames: number) => void
export type { QualityPhase }

export interface FieldPerf {
  /** Last rAF delta in milliseconds. 0 before the first real tick. */
  rafIntervalMs: number
  /** Extra logical frames applied this tick (0 = on time). */
  catchUpJump: number
  /** Milliseconds spent advancing subscribers this tick. */
  jsLatenessMs: number
  /**
   * Shape elements painted on the field. A SmartBVA master's mounted
   * shapes are multiplied by how many `<use>` copies actually draw it, so
   * a crowd of 20 identical actors counts as 20× the master's shapes — whether
   * those copies are mid-gesture or holding a still pose. Tracks segment
   * and skin swaps, and drops copies the weak-device filter hid.
   */
  shapes: number
  /**
   * Shapes resolution-aware culling removed to reach {@link shapes}, also
   * multiplied by the number of draws that would have shown them.
   */
  culledShapes: number
  /** Algorithmic pose writes skipped this tick. Not included in catchUpJump. */
  skips: number
  /** Field-level pose-skip N (0 = write every pose). */
  N: number
  phase: QualityPhase
  /** True after measure if the device was classified weak, or when forced. */
  weak: boolean
}

interface Subscriber {
  fps: number
  accumMs: number
  fn: FrameFn
}

const subscribers = new Set<Subscriber>()
const postFrame = new Set<() => void>()
let raf = 0
let lastNow = 0

const latest: FieldPerf = {
  rafIntervalMs: 0,
  catchUpJump: 0,
  jsLatenessMs: 0,
  shapes: 0,
  culledShapes: 0,
  skips: 0,
  N: 0,
  phase: 'load',
  weak: false,
}

/** Live shape census per mounted rig, keyed by an identity the rig owns. */
const rigShapes = new Map<
  object,
  { mounted: number; culled: number; draws: number }
>()
const perfListeners = new Set<(perf: FieldPerf) => void>()
let flushTimer = 0
const FLUSH_MS = 500

function sumRigShapes(): void {
  let mounted = 0
  let culled = 0
  for (const c of rigShapes.values()) {
    mounted += c.mounted * c.draws
    culled += c.culled * c.draws
  }
  latest.shapes = mounted
  latest.culledShapes = culled
}

function copyPerf(): FieldPerf {
  return {
    rafIntervalMs: latest.rafIntervalMs,
    catchUpJump: latest.catchUpJump,
    jsLatenessMs: latest.jsLatenessMs,
    shapes: latest.shapes,
    culledShapes: latest.culledShapes,
    skips: latest.skips,
    N: latest.N,
    phase: latest.phase,
    weak: latest.weak,
  }
}

function armFlush(): void {
  if (flushTimer !== 0 || perfListeners.size === 0) return
  flushTimer = window.setTimeout(() => {
    flushTimer = 0
    if (perfListeners.size === 0) return
    const perf = copyPerf()
    for (const fn of perfListeners) fn(perf)
    armFlush()
  }, FLUSH_MS)
}

function loop(now: number): void {
  raf = 0
  const dt = lastNow === 0 ? 0 : now - lastNow
  lastNow = now
  // A backgrounded tab can hand us a huge delta; cap it so a field does not
  // fast-forward through a whole animation on return.
  const clamped = Math.min(dt, 250)
  beginTickSkips()
  const t0 = performance.now()
  let maxFrames = 0
  for (const sub of Array.from(subscribers)) {
    if (!subscribers.has(sub)) continue
    sub.accumMs += clamped
    const frameMs = 1000 / sub.fps
    let frames = 0
    while (sub.accumMs >= frameMs) {
      sub.accumMs -= frameMs
      frames += 1
    }
    if (frames > maxFrames) maxFrames = frames
    if (frames > 0) sub.fn(frames)
  }
  for (const fn of postFrame) fn()
  const work = performance.now() - t0
  latest.skips = takeTickSkips()
  if (dt > 0) {
    latest.rafIntervalMs = dt
    latest.catchUpJump = maxFrames > 1 ? maxFrames - 1 : 0
    latest.jsLatenessMs = work
    tickQuality({
      rafIntervalMs: dt,
      catchUpJump: latest.catchUpJump,
      jsLatenessMs: work,
    })
  }
  latest.N = getFieldN()
  latest.phase = getQualityPhase()
  latest.weak = isFieldWeak()
  if (subscribers.size > 0) raf = requestAnimationFrame(loop)
  else lastNow = 0
}

/**
 * Runs once per rAF after every timing subscriber has advanced. Canvas
 * bands paint here so they always see the frame the masters just wrote.
 * Does not keep the loop alive on its own.
 */
export function subscribePostFrame(fn: () => void): () => void {
  postFrame.add(fn)
  return () => {
    postFrame.delete(fn)
  }
}

export function subscribeFrames(fps: number, fn: FrameFn): () => void {
  const sub: Subscriber = { fps: fps > 0 ? fps : 24, accumMs: 0, fn }
  subscribers.add(sub)
  if (raf === 0) {
    lastNow = 0
    raf = requestAnimationFrame(loop)
  }
  return () => {
    subscribers.delete(sub)
    if (subscribers.size === 0 && raf !== 0) {
      cancelAnimationFrame(raf)
      raf = 0
      lastNow = 0
    }
  }
}

/** Snapshot of the latest sample. Safe to call from a quality scaler. */
export function getFieldPerf(): FieldPerf {
  return copyPerf()
}

/**
 * Push a copy of {@link getFieldPerf} about twice a second. Sampling itself
 * is always on; this only wakes a UI / scaler listener.
 */
export function subscribeFieldPerf(fn: (perf: FieldPerf) => void): () => void {
  perfListeners.add(fn)
  fn(copyPerf())
  armFlush()
  return () => {
    perfListeners.delete(fn)
    if (perfListeners.size === 0 && flushTimer !== 0) {
      window.clearTimeout(flushTimer)
      flushTimer = 0
    }
  }
}

/**
 * Publish one rig's shape census. `draws` is how many times those shapes
 * appear on the field (1 for a solo BVA, N for a SmartBVA master with N
 * visible `<use>` copies). Safe to call on every bundle swap: a re-resolve
 * at a new culling tier changes both numbers, so unlike a launch counter
 * this has to be overwritten rather than recorded once.
 */
export function recordRigShapes(
  key: object,
  counts: { mounted: number; culled: number },
  draws = 1,
): void {
  const n = draws > 0 ? draws : 0
  const prev = rigShapes.get(key)
  if (
    prev &&
    prev.mounted === counts.mounted &&
    prev.culled === counts.culled &&
    prev.draws === n
  ) {
    return
  }
  rigShapes.set(key, { mounted: counts.mounted, culled: counts.culled, draws: n })
  sumRigShapes()
}

export function releaseRigShapes(key: object): void {
  if (!rigShapes.delete(key)) return
  sumRigShapes()
}
