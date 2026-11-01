export const MUSIC_FADE_MS = 600

/** Fade only music, keeping source pause/resume separate from the shared context. */
export function createMusicFade(
  ctx: AudioContext,
  gain: GainNode,
  options: { initiallyPaused: boolean; onPause: () => void; onResume: () => void },
) {
  let target = options.initiallyPaused ? 0 : 1
  let from = target
  let startedAt = ctx.currentTime
  let suspended = options.initiallyPaused
  let timer: ReturnType<typeof setTimeout> | undefined
  gain.gain.value = target

  return {
    setPaused(paused: boolean) {
      const next = paused ? 0 : 1
      if (next === target) return
      clearTimeout(timer)
      timer = undefined
      const now = ctx.currentTime
      const progress = Math.min(1, Math.max(0, (now - startedAt) / (MUSIC_FADE_MS / 1000)))
      const current = from + (target - from) * progress
      from = current
      target = next
      startedAt = now
      gain.gain.cancelScheduledValues(now)
      gain.gain.setValueAtTime(current, now)
      gain.gain.linearRampToValueAtTime(next, now + MUSIC_FADE_MS / 1000)
      if (!paused && suspended) {
        suspended = false
        options.onResume()
      }
      if (paused) {
        timer = setTimeout(() => {
          timer = undefined
          suspended = true
          options.onPause()
        }, MUSIC_FADE_MS)
      }
    },
    dispose() {
      clearTimeout(timer)
      gain.gain.cancelScheduledValues(ctx.currentTime)
    },
  }
}
