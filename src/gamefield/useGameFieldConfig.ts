import { useEffect, useState } from 'react'
import type { GameFieldConfig } from './types'

const cache = new Map<string, Promise<GameFieldConfig>>()

/** Drop a cached field JSON so the next load refetches (e.g. after overwriting a version). */
export function evictGameFieldConfigCache(url?: string): void {
  if (url === undefined) cache.clear()
  else cache.delete(url)
}

/** Seed the cache after a successful overwrite so reload does not pick up a stale GET. */
export function primeGameFieldConfigCache(
  url: string,
  config: GameFieldConfig,
): void {
  cache.set(url, Promise.resolve(structuredClone(config)))
}

function fetchConfig(url: string): Promise<GameFieldConfig> {
  let p = cache.get(url)
  if (!p) {
    p = fetch(url, { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error(`Failed to load gamefield: ${url} (${r.status})`)
        return r.json() as Promise<GameFieldConfig>
      })
      .catch((err: unknown) => {
        cache.delete(url)
        throw err
      })
    cache.set(url, p)
  }
  return p
}

/** Fetch and cache a `GameFieldConfig` JSON document. */
export function useGameFieldConfig(url: string | null, reloadToken = 0) {
  const [config, setConfig] = useState<GameFieldConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!url) {
      setConfig(null)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchConfig(url)
      .then((c) => {
        if (!cancelled) setConfig(c)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setConfig(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [url, reloadToken])

  return { config, error, loading }
}
