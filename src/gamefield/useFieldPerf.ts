import { useEffect, useState } from 'react'
import {
  getFieldPerf,
  subscribeFieldPerf,
  type FieldPerf,
} from './frameClock'

/**
 * Mirror {@link getFieldPerf} into React about twice a second while
 * `enabled`. The clock keeps sampling either way; this hook is only the HUD
 * / scaler subscription.
 */
export function useFieldPerf(enabled: boolean): FieldPerf | null {
  const [perf, setPerf] = useState<FieldPerf | null>(null)

  useEffect(() => {
    if (!enabled) {
      setPerf(null)
      return
    }
    setPerf(getFieldPerf())
    return subscribeFieldPerf(setPerf)
  }, [enabled])

  return perf
}
