import { useEffect, useRef } from 'react'
import type { FieldAudio } from './fieldAudio'
import type { FlatAsset } from './layout'
import {
  findSoundState,
  resolveClipUrl,
  soundChannel,
  soundLoop,
  soundVolume,
} from './soundAssets'

interface SoundSnap {
  state: string
  seq: number
  active: boolean
  gated: boolean
  loop: boolean
  clip: string | undefined
}

/**
 * Drive state-triggered sound assets: looping beds follow effectiveState;
 * oneshots fire whenever that state is set (including a re-set).
 * Manual assets are ignored here — `playSound` owns those.
 */
export function useFieldSounds(
  flat: FlatAsset[],
  playback: Record<string, { state: string; seq: number; active: boolean }>,
  clips: Record<string, string> | undefined,
  audio: FieldAudio,
  bgEnabled: boolean,
  sfxEnabled: boolean,
): void {
  const prevRef = useRef<Record<string, SoundSnap>>({})

  useEffect(() => {
    const prev = prevRef.current
    const next: Record<string, SoundSnap> = {}

    for (const { asset } of flat) {
      if (asset.type !== 'sound') continue
      if ((asset.trigger ?? 'state') === 'manual') continue

      const entry = playback[asset.id]
      if (!entry) {
        audio.stop(asset.id)
        continue
      }

      const def = findSoundState(asset, entry.state)
      const loop = soundLoop(asset, def)
      const channel = soundChannel(asset, loop)
      const gated = (channel === 'bg' ? bgEnabled : sfxEnabled) && entry.active
      const clip = def?.clip ?? (def ? undefined : asset.clip)
      const snap: SoundSnap = {
        state: entry.state,
        seq: entry.seq,
        active: entry.active,
        gated,
        loop,
        clip,
      }
      next[asset.id] = snap

      if (!gated || !clip) {
        audio.stop(asset.id)
        continue
      }

      const before = prev[asset.id]
      if (loop) {
        const keepBed =
          before?.gated && before.loop && before.clip === clip
        if (keepBed) continue
        audio.play({
          id: asset.id,
          url: resolveClipUrl(clip, clips),
          loop: true,
          volume: soundVolume(asset, def),
          channel,
        })
        continue
      }

      const sameOneshot =
        before?.gated &&
        !before.loop &&
        before.seq === snap.seq &&
        before.state === snap.state &&
        before.clip === clip
      if (sameOneshot) continue
      audio.play({
        id: asset.id,
        url: resolveClipUrl(clip, clips),
        loop: false,
        volume: soundVolume(asset, def),
        channel,
      })
    }

    for (const id of Object.keys(prev)) {
      if (!next[id]) audio.stop(id)
    }
    prevRef.current = next
  }, [flat, playback, clips, audio, bgEnabled, sfxEnabled])
}
