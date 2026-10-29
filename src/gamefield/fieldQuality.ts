/**
 * Field-level load → measure → cooldown state machine.
 *
 * Ticked from the shared rAF loop. React only learns about phase / weak
 * flips through {@link subscribeQuality}; pose-skip N is read by each rig
 * on the clock thread.
 */

import {
  DEFAULT_MAX_N,
  DEFAULT_MEASURE_MS,
  DEFAULT_WEAK_AVG_JS_MS,
  DEFAULT_WEAK_RAF_HZ,
  DEFAULT_WEAK_TOTAL_SKIPS,
} from './types'
import { effectiveSkipN, type FieldQualityConfig } from './resolveQuality'

export type QualityPhase = 'load' | 'measure' | 'run'

export interface QualitySnapshot {
  phase: QualityPhase
  N: number
  weak: boolean
}

const RAMP_EVERY = 2
const RECOVER_EVERY = 15

const defaults: FieldQualityConfig = {
  maxN: DEFAULT_MAX_N,
  measureMs: DEFAULT_MEASURE_MS,
  weakRafHz: DEFAULT_WEAK_RAF_HZ,
  weakTotalSkips: DEFAULT_WEAK_TOTAL_SKIPS,
  weakAvgJsMs: DEFAULT_WEAK_AVG_JS_MS,
}

let config: FieldQualityConfig = { ...defaults }
let phase: QualityPhase = 'load'
let fieldN = 0
let weak = false
/** Host override so Studio can preview the weak-device cull without measuring. */
let forceWeak = false

const registered = new Set<object>()
const ready = new Set<object>()

let measureStartedAt = 0
let measureTicks = 0
let measureIntervalSum = 0
let measureJumpSum = 0
let measureJsSum = 0

let rampTicks = 0
let recoverTicks = 0

let poseSkips = 0

const qualityListeners = new Set<(snap: QualitySnapshot) => void>()

function snapshot(): QualitySnapshot {
  return { phase, N: fieldN, weak: weak || forceWeak }
}

function emitQuality(): void {
  if (qualityListeners.size === 0) return
  const snap = snapshot()
  for (const fn of qualityListeners) fn(snap)
}

function enterMeasure(): void {
  phase = 'measure'
  measureStartedAt = performance.now()
  measureTicks = 0
  measureIntervalSum = 0
  measureJumpSum = 0
  measureJsSum = 0
  emitQuality()
}

function enterRun(isWeak: boolean): void {
  phase = 'run'
  weak = isWeak
  fieldN = 0
  rampTicks = 0
  recoverTicks = 0
  emitQuality()
}

function tryLeaveLoad(): void {
  if (phase !== 'load') return
  if (registered.size === 0) return
  if (ready.size < registered.size) return
  enterMeasure()
}

function classifyWeak(): boolean {
  const avgHz =
    measureIntervalSum > 0
      ? (measureTicks * 1000) / measureIntervalSum
      : 0
  const avgJs = measureTicks > 0 ? measureJsSum / measureTicks : 0
  return (
    avgHz < config.weakRafHz ||
    measureJumpSum >= config.weakTotalSkips ||
    avgJs > config.weakAvgJsMs
  )
}

/** Apply field knobs. Does not reset the phase machine. */
export function setQualityConfig(next: FieldQualityConfig): void {
  config = { ...next }
  if (fieldN > config.maxN) fieldN = config.maxN
}

/**
 * Treat the field as weak regardless of the measure. Hosts use this to
 * preview `renderOnWeakDevice` / distribution culls on a fast machine.
 */
export function setForceWeak(on: boolean): void {
  if (forceWeak === on) return
  forceWeak = on
  emitQuality()
}

/** Wipe load / measure / N. Call when a field mounts, unmounts, or changes id. */
export function resetQuality(): void {
  phase = 'load'
  fieldN = 0
  weak = false
  registered.clear()
  ready.clear()
  measureStartedAt = 0
  measureTicks = 0
  measureIntervalSum = 0
  measureJumpSum = 0
  measureJsSum = 0
  rampTicks = 0
  recoverTicks = 0
  poseSkips = 0
  emitQuality()
}

export function registerQualityRig(key: object): void {
  registered.add(key)
}

export function markQualityRigReady(key: object): void {
  if (!registered.has(key)) return
  ready.add(key)
  tryLeaveLoad()
}

export function unregisterQualityRig(key: object): void {
  registered.delete(key)
  ready.delete(key)
}

export function getFieldN(): number {
  return fieldN
}

export function getQualityPhase(): QualityPhase {
  return phase
}

export function isFieldWeak(): boolean {
  return weak || forceWeak
}

export function getQualitySnapshot(): QualitySnapshot {
  return snapshot()
}

export function skipNForPriority(priority: number): number {
  return effectiveSkipN(fieldN, priority)
}

/** Count one algorithmic pose-write skip for this rAF tick. */
export function recordPoseSkip(): void {
  poseSkips += 1
}

export function beginTickSkips(): void {
  poseSkips = 0
}

export function takeTickSkips(): number {
  return poseSkips
}

/**
 * Advance the machine from one rAF sample. `catchUpJump` is rAF catch-up
 * only — never include algorithmic pose skips.
 */
export function tickQuality(sample: {
  rafIntervalMs: number
  catchUpJump: number
  jsLatenessMs: number
}): void {
  if (phase === 'load') {
    tryLeaveLoad()
    return
  }

  if (phase === 'measure') {
    if (sample.rafIntervalMs > 0) {
      measureTicks += 1
      measureIntervalSum += sample.rafIntervalMs
      measureJumpSum += sample.catchUpJump
      measureJsSum += sample.jsLatenessMs
    }
    if (performance.now() - measureStartedAt >= config.measureMs) {
      enterRun(classifyWeak())
    }
    return
  }

  if (sample.catchUpJump > 1) {
    recoverTicks = 0
    rampTicks += 1
    if (rampTicks >= RAMP_EVERY) {
      rampTicks = 0
      if (fieldN < config.maxN) fieldN += 1
    }
    return
  }

  rampTicks = 0
  if (fieldN <= 0) {
    recoverTicks = 0
    return
  }
  recoverTicks += 1
  if (recoverTicks >= RECOVER_EVERY) {
    recoverTicks = 0
    fieldN -= 1
  }
}

/** Fires immediately, then on phase / weak changes. */
export function subscribeQuality(fn: (snap: QualitySnapshot) => void): () => void {
  qualityListeners.add(fn)
  fn(snapshot())
  return () => {
    qualityListeners.delete(fn)
  }
}
