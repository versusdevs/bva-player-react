import { useEffect, useRef, useState } from 'react'
import {
  getQualitySnapshot,
  resetQuality,
  subscribeQuality,
  type QualitySnapshot,
} from './fieldQuality'

const LOAD_SNAP: QualitySnapshot = { phase: 'load', N: 0, weak: false }

/**
 * Wake React when the field quality phase or weak flag changes.
 * Pass `fieldId` so a scene swap resets the machine before children register.
 */
export function useFieldQuality(fieldId?: string): QualitySnapshot {
  const [snap, setSnap] = useState(getQualitySnapshot)
  const idRef = useRef<string | null>(null)
  let current = snap

  if (fieldId !== undefined && idRef.current !== fieldId) {
    resetQuality()
    idRef.current = fieldId
    current = LOAD_SNAP
    if (snap.phase !== 'load' || snap.N !== 0 || snap.weak) {
      setSnap(LOAD_SNAP)
    }
  }

  useEffect(() => subscribeQuality(setSnap), [])

  useEffect(() => {
    return () => resetQuality()
  }, [])

  return current
}
