import { WebHaptics, type HapticInput, type TriggerOptions } from 'web-haptics'

export type {
  HapticInput,
  HapticPattern,
  HapticPreset,
  Vibration as HapticVibration,
  TriggerOptions as HapticTriggerOptions,
} from 'web-haptics'

export interface HapticFeedbackOptions {
  /** Independent of audio volume and mute. Default true. */
  enabled?: boolean
}

export interface HapticFeedback {
  /** Play a preset, duration, or pattern. Replaces any in-flight feedback. */
  play: (input?: HapticInput, options?: TriggerOptions) => void
  stop: () => void
  setEnabled: (enabled: boolean) => void
  /** Stop feedback and release the hidden iOS switch and event listener. */
  destroy: () => void
}

/**
 * Reusable mobile-web haptics, including iOS's switch-based fallback.
 * Call play synchronously from a user gesture; a whole pattern can include
 * delayed impacts. Construction is SSR-safe and does not touch the DOM.
 */
export function createHapticFeedback(
  options: HapticFeedbackOptions = {},
): HapticFeedback {
  let enabled = options.enabled ?? true
  let destroyed = false
  let engine: WebHaptics | null = null
  let owner: Document | null = null

  function stop(): void {
    try {
      engine?.cancel()
    } catch {
      // A blocked vibration API must never interrupt playback.
    }
  }

  function onVisibilityChange(): void {
    if (owner?.hidden) stop()
  }

  return {
    play(input, triggerOptions) {
      if (!enabled || destroyed || typeof document === 'undefined') return
      if (!document.body || document.hidden) return
      if (!engine) {
        // Do not gate on WebHaptics.isSupported: it only detects vibrate(),
        // which would exclude the working iOS switch fallback.
        engine = new WebHaptics({ debug: false, showSwitch: false })
        owner = document
        owner.addEventListener('visibilitychange', onVisibilityChange)
      }
      // No await before trigger: preserve the originating user gesture on iOS.
      void engine.trigger(input, triggerOptions).catch(() => {
        // Unsupported or restricted devices silently skip feedback.
      })
    },
    stop,
    setEnabled(next) {
      enabled = next
      if (!enabled) stop()
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      // WebHaptics.destroy removes its switch/RAF; cancel also stops Android.
      stop()
      engine?.destroy()
      engine = null
      owner?.removeEventListener('visibilitychange', onVisibilityChange)
      owner = null
    },
  }
}
