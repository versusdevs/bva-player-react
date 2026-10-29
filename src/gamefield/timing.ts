import type { TimingStep } from './types'

/**
 * Timing programs.
 *
 * A state's `timing` array is a tiny script the field runs against a baked
 * segment: play a frame range, hold for a while, repeat. Without a program a
 * state plays once and freezes on its last frame — useful when clips are
 * single non-looping gestures and any repeat/pause has to be scripted rather
 * than baked into padded frames.
 */

interface PlayStep {
  kind: 'play'
  from: number
  to: number
}

interface WaitStep {
  kind: 'wait'
  frames: number
}

interface StopStep {
  kind: 'stop'
}

type Step = PlayStep | WaitStep | StopStep

export interface TimingProgram {
  steps: Step[]
  /** Restart at step 0 after the last step instead of freezing. */
  loop: boolean
}

const RANGE = /^(\d*)\s*:\s*(\d*)$/

function parseStep(step: TimingStep, lastFrame: number): Step | null {
  if (typeof step === 'number') {
    if (step === -1) return { kind: 'stop' }
    if (step >= 1) return { kind: 'wait', frames: Math.round(step) }
    return null
  }
  const trimmed = step.trim()
  if (trimmed === '-1') return { kind: 'stop' }
  const range = RANGE.exec(trimmed)
  if (range) {
    const from = range[1] === '' ? 0 : Number(range[1])
    const to = range[2] === '' ? lastFrame : Number(range[2])
    return {
      kind: 'play',
      from: clamp(from, 0, lastFrame),
      to: clamp(to, 0, lastFrame),
    }
  }
  const asNumber = Number(trimmed)
  if (Number.isFinite(asNumber)) return parseStep(asNumber, lastFrame)
  return null
}

function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n
}

/**
 * Compile a state's timing into runnable steps. `segmentFrames` is the baked
 * length; ranges are clamped to it so a config can outlive a re-bake.
 */
export function compileTiming(
  timing: TimingStep[] | undefined,
  segmentFrames: number,
): TimingProgram {
  const lastFrame = Math.max(0, segmentFrames - 1)
  if (!timing || timing.length === 0) {
    return {
      steps: [{ kind: 'play', from: 0, to: lastFrame }, { kind: 'stop' }],
      loop: false,
    }
  }
  const steps: Step[] = []
  for (const raw of timing) {
    const step = parseStep(raw, lastFrame)
    if (step) steps.push(step)
  }
  if (steps.length === 0) {
    return { steps: [{ kind: 'stop' }], loop: false }
  }
  return { steps, loop: true }
}

export interface TimingRunner {
  /** Advance the program by whole frames; returns the frame to display. */
  advance: (frames: number) => number
  /** Frame to display before the first advance. */
  currentFrame: () => number
  done: () => boolean
}

/** Stateful cursor over a compiled program. */
export function createTimingRunner(program: TimingProgram): TimingRunner {
  const first = program.steps[0]
  let stepIndex = 0
  let frame = first?.kind === 'play' ? first.from : 0
  let held = 0
  let stopped = first?.kind === 'stop'

  function nextStep(): void {
    held = 0
    if (stepIndex + 1 < program.steps.length) {
      stepIndex += 1
    } else if (program.loop) {
      stepIndex = 0
    } else {
      stopped = true
      return
    }
    const step = program.steps[stepIndex]
    if (step.kind === 'stop') stopped = true
    else if (step.kind === 'play') frame = step.from
  }

  function advanceOne(): void {
    if (stopped) return
    const step = program.steps[stepIndex]
    if (step.kind === 'stop') {
      stopped = true
      return
    }
    if (step.kind === 'wait') {
      held += 1
      if (held >= step.frames) nextStep()
      return
    }
    if (frame < step.to) {
      frame += 1
      return
    }
    // Range finished on this frame; move on and land on the next step's start.
    nextStep()
    const landed = program.steps[stepIndex]
    if (!stopped && landed?.kind === 'play') frame = landed.from
  }

  return {
    advance(frames: number) {
      for (let i = 0; i < frames && !stopped; i++) advanceOne()
      return frame
    },
    currentFrame: () => frame,
    done: () => stopped,
  }
}
