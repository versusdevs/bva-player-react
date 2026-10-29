import type { CSSProperties, ReactNode } from 'react'

export interface BvaLoaderProps {
  label?: string
  className?: string
  style?: CSSProperties
}

/** A self-contained indicator with no stylesheet or asset download needed. */
export function BvaLoader({ label = 'Loading…', className, style }: BvaLoaderProps) {
  return (
    <div role="status" className={className} style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: 12, color: '#e8edf5',
      font: '14px system-ui, sans-serif', ...style,
    }}>
      <style>{`
        @keyframes bva-loader-spin { to { transform: rotate(360deg); } }
        .bva-loader-spinner { animation: bva-loader-spin .8s linear infinite; }
        @media (prefers-reduced-motion: reduce) {
          .bva-loader-spinner { animation: none; }
        }
      `}</style>
      <span aria-hidden="true" className="bva-loader-spinner" style={{
        width: 28, height: 28, border: '3px solid currentColor',
        borderRightColor: 'transparent', borderRadius: '50%', opacity: .8,
      }} />
      <span>{label}</span>
    </div>
  )
}

/** Keep the player mounted below the overlay so it can finish initializing. */
export function BvaLoadingOverlay({ children = <BvaLoader /> }: { children?: ReactNode }) {
  if (children === null || children === false) return null
  return (
    <div className="bva-loading-overlay" style={{
      position: 'absolute', inset: 0, zIndex: 1,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0b0d10',
    }}>
      {children}
    </div>
  )
}
