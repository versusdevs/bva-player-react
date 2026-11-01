import { createMusicFade } from './musicFade'
import type { SoundChannel } from './types'

export interface FieldAudioPlayRequest {
  id: string
  url: string
  loop: boolean
  volume: number
  channel: SoundChannel
}

export interface FieldAudioHandle {
  stop: () => void
}

export interface FieldAudio {
  play: (req: FieldAudioPlayRequest) => FieldAudioHandle
  stop: (id: string) => void
  stopAll: () => void
  setVolume: (volume: number) => void
  setEnabled: (bg: boolean, sfx: boolean) => void
  setBackgroundPaused: (paused: boolean) => void
  preload: (urls: string[]) => void
}

interface LiveSource {
  id: string
  channel: SoundChannel
  stop: () => void
}

let audioCtx: AudioContext | null = null
const bufferCache = new Map<string, AudioBuffer>()
const bufferLoading = new Map<string, Promise<AudioBuffer | null>>()
const unlockListeners = new Set<() => void>()
let gestureUnlockInstalled = false

function notifyUnlocked(): void {
  for (const fn of [...unlockListeners]) fn()
}

/** Resume the shared context. Browsers only allow this during a user gesture. */
export function unlockFieldAudio(): Promise<boolean> {
  const ctx = getContext()
  if (!ctx) return Promise.resolve(false)
  if (ctx.state === 'running') return Promise.resolve(true)
  return ctx
    .resume()
    .then(() => {
      const ok = ctx.state === 'running'
      if (ok) notifyUnlocked()
      return ok
    })
    .catch(() => false)
}

export function onFieldAudioUnlocked(fn: () => void): () => void {
  unlockListeners.add(fn)
  return () => {
    unlockListeners.delete(fn)
  }
}

function installGestureUnlock(): void {
  if (typeof window === 'undefined' || gestureUnlockInstalled) return
  gestureUnlockInstalled = true
  const onGesture = () => {
    void unlockFieldAudio()
  }
  window.addEventListener('pointerdown', onGesture)
  window.addEventListener('keydown', onGesture)
}

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  try {
    if (!audioCtx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext
      if (!AC) return null
      audioCtx = new AC()
    }
    return audioCtx
  } catch {
    return null
  }
}

function resumeContext(ctx: AudioContext): void {
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      if (ctx.state === 'running') notifyUnlocked()
    }).catch(() => {})
  }
}

async function fetchAudioData(path: string): Promise<ArrayBuffer | null> {
  const res = await fetch(path)
  if (!res.ok) return null
  return res.arrayBuffer()
}

function loadBuffer(path: string): Promise<AudioBuffer | null> {
  const cached = bufferCache.get(path)
  if (cached) return Promise.resolve(cached)

  const inflight = bufferLoading.get(path)
  if (inflight) return inflight

  const ctx = getContext()
  if (!ctx) return Promise.resolve(null)

  const promise = fetchAudioData(path)
    .then((arrayBuf) => {
      if (!arrayBuf) return null
      return ctx.decodeAudioData(arrayBuf)
    })
    .then((decoded) => {
      if (decoded) bufferCache.set(path, decoded)
      bufferLoading.delete(path)
      return decoded
    })
    .catch(() => {
      bufferLoading.delete(path)
      return null
    })

  bufferLoading.set(path, promise)
  return promise
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 1
  if (n < 0) return 0
  if (n > 1) return 1
  return n
}

function startSource(
  ctx: AudioContext,
  destination: AudioNode,
  buffer: AudioBuffer,
  opts: { volume: number; loop: boolean; onEnded?: () => void },
): FieldAudioHandle {
  const source = ctx.createBufferSource()
  const gain = ctx.createGain()
  source.buffer = buffer
  source.loop = opts.loop
  gain.gain.value = opts.volume
  source.connect(gain)
  gain.connect(destination)
  source.start(0)

  let stopped = false
  const handle = {
    stop() {
      if (stopped) return
      stopped = true
      try {
        source.stop()
        source.disconnect()
        gain.disconnect()
      } catch {
        // already stopped
      }
    },
  }

  if (!opts.loop) {
    source.onended = () => {
      if (stopped) return
      stopped = true
      try {
        source.disconnect()
        gain.disconnect()
      } catch {
        // already disconnected
      }
      opts.onEnded?.()
    }
  }

  return handle
}

const noopHandle: FieldAudioHandle = { stop() {} }

function noopAudio(): FieldAudio {
  return {
    play: () => noopHandle,
    stop() {},
    stopAll() {},
    setVolume() {},
    setEnabled() {},
    setBackgroundPaused() {},
    preload() {},
  }
}

/**
 * Per-field audio mixer. Shares one page-level AudioContext and buffer cache;
 * each instance has its own master gain and live-source set.
 */
export function createFieldAudio(opts: {
  volume: number
  bgEnabled: boolean
  bgPaused?: boolean
  sfxEnabled: boolean
}): FieldAudio {
  if (typeof window === 'undefined') return noopAudio()

  installGestureUnlock()
  const maybeCtx = getContext()
  if (!maybeCtx) return noopAudio()
  const ctx: AudioContext = maybeCtx

  const master = ctx.createGain()
  master.gain.value = clamp01(opts.volume)
  master.connect(ctx.destination)

  const background = ctx.createGain()
  background.connect(master)
  let backgroundSuspended = opts.bgPaused ?? false
  const fade = createMusicFade(ctx, background, {
    initiallyPaused: backgroundSuspended,
    onPause() {
      backgroundSuspended = true
      stopChannel('bg')
    },
    onResume() {
      backgroundSuspended = false
      for (const req of lastBeds.values()) {
        if (req.channel === 'bg') playReq(req)
      }
    },
  })

  let bgEnabled = opts.bgEnabled
  let sfxEnabled = opts.sfxEnabled
  const lives: LiveSource[] = []
  const lastBeds = new Map<string, FieldAudioPlayRequest>()

  const replayBeds = () => {
    for (const req of lastBeds.values()) playReq(req)
  }
  unlockListeners.add(replayBeds)

  function removeLive(stop: () => void): void {
    const i = lives.findIndex((live) => live.stop === stop)
    if (i >= 0) lives.splice(i, 1)
  }

  function stopId(id: string): void {
    for (const live of [...lives]) {
      if (live.id === id) live.stop()
    }
  }

  function stopChannel(channel: SoundChannel): void {
    for (const live of [...lives]) {
      if (live.channel === channel) live.stop()
    }
  }

  function channelOn(channel: SoundChannel): boolean {
    return channel === 'bg' ? bgEnabled && !backgroundSuspended : sfxEnabled
  }

  function playReq(req: FieldAudioPlayRequest): FieldAudioHandle {
      if (req.loop) lastBeds.set(req.id, req)
      if (!channelOn(req.channel)) return noopHandle
      resumeContext(ctx)
      if (req.loop) stopId(req.id)

      let cancelled = false
      let inner: FieldAudioHandle | null = null
      const live: LiveSource = {
        id: req.id,
        channel: req.channel,
        stop() {
          cancelled = true
          inner?.stop()
          removeLive(live.stop)
        },
      }
      lives.push(live)

      const attach = (buffer: AudioBuffer) => {
        inner = startSource(ctx, req.channel === 'bg' ? background : master, buffer, {
          volume: clamp01(req.volume),
          loop: req.loop,
          onEnded: () => removeLive(live.stop),
        })
      }

      const buffer = bufferCache.get(req.url)
      if (buffer) {
        attach(buffer)
        return live
      }

      loadBuffer(req.url).then((decoded) => {
        if (!decoded || cancelled) return
        if (!channelOn(req.channel)) return
        attach(decoded)
      })
      return live
  }

  return {
    play: playReq,
    stop(id) {
      lastBeds.delete(id)
      stopId(id)
    },
    stopAll() {
      lastBeds.clear()
      for (const live of [...lives]) live.stop()
      unlockListeners.delete(replayBeds)
      fade.dispose()
    },
    setVolume(volume) {
      master.gain.value = clamp01(volume)
    },
    setBackgroundPaused(paused) {
      fade.setPaused(paused)
    },
    setEnabled(bg, sfx) {
      bgEnabled = bg
      sfxEnabled = sfx
      if (!bg) stopChannel('bg')
      if (!sfx) stopChannel('sfx')
    },
    preload(urls) {
      resumeContext(ctx)
      for (const url of urls) loadBuffer(url)
    },
  }
}
