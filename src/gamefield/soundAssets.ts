import { flattenAssets } from './layout'
import type {
  GameFieldConfig,
  SoundAssetConfig,
  SoundChannel,
  SoundStateDef,
} from './types'

/** Host `clips` map wins; otherwise the clip string is treated as a URL. */
export function resolveClipUrl(
  clip: string,
  clips?: Record<string, string>,
): string {
  return clips?.[clip] ?? clip
}

export function soundLoop(
  asset: SoundAssetConfig,
  def?: SoundStateDef,
): boolean {
  return def?.loop ?? asset.loop ?? false
}

export function soundChannel(
  asset: SoundAssetConfig,
  loop: boolean,
): SoundChannel {
  return asset.channel ?? (loop ? 'bg' : 'sfx')
}

export function soundVolume(
  asset: SoundAssetConfig,
  def?: SoundStateDef,
  stepVolume?: number,
): number {
  const raw = stepVolume ?? def?.volume ?? asset.volume ?? 1
  if (!Number.isFinite(raw)) return 1
  if (raw < 0) return 0
  if (raw > 1) return 1
  return raw
}

export function findSoundState(
  asset: SoundAssetConfig,
  state: string,
): SoundStateDef | undefined {
  return asset.states?.find((entry) => entry.state === state)
}

/** Every URL a field's sound assets may fetch, for preload. */
export function collectSoundUrls(
  config: GameFieldConfig,
  clips?: Record<string, string>,
): string[] {
  const urls = new Set<string>()
  const add = (clip?: string) => {
    if (!clip) return
    urls.add(resolveClipUrl(clip, clips))
  }
  for (const { asset } of flattenAssets(config.assets)) {
    if (asset.type !== 'sound') continue
    add(asset.clip)
    for (const def of asset.states ?? []) add(def.clip)
    for (const steps of Object.values(asset.cues ?? {})) {
      for (const step of steps) add(step.clip)
    }
  }
  return [...urls]
}
