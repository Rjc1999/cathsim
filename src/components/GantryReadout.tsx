import { useGantryStore } from '../store/useGantryStore'

/**
 * Live gantry readout in the cath-lab monitor idiom: "LAO 34°   CRA 28°", "RAO 30°   CAU 20°", or "AP 0°" when the
 * gantry is at 0°/0°. Angles are whole degrees, as on the real console. The selectors round, so the badge only
 * re-renders when a displayed degree changes (smooth during drag, no per-pixel React work).
 * The reading is the commanded pose.
 */
function formatReadout(alpha: number, beta: number): { primary: string; secondary: string | null } {
  const a = Math.round(alpha)
  const b = Math.round(beta)
  const primary = a === 0 ? 'AP 0°' : `${a > 0 ? 'LAO' : 'RAO'} ${Math.abs(a)}°`
  if (a === 0 && b === 0) return { primary, secondary: null }
  const secondary = `${b >= 0 ? 'CRA' : 'CAU'} ${Math.abs(b)}°`
  return { primary, secondary }
}

export function GantryReadout({ className = '' }: { className?: string }) {
  const alpha = useGantryStore((s) => Math.round(s.alpha))
  const beta = useGantryStore((s) => Math.round(s.beta))
  const phase = useGantryStore((s) => s.phase)
  const { primary, secondary } = formatReadout(alpha, beta)

  return (
    <div
      className={`pointer-events-none flex flex-col gap-1 rounded-md bg-black/75 px-2.5 py-1.5 font-mono shadow-lg ring-1 ring-white/10 backdrop-blur-sm ${className}`}
      role="status"
      aria-label={`Gantry angle ${primary}${secondary ? ' ' + secondary : ''}`}
    >
      <div className="flex items-center gap-1.5 text-[10px] tracking-widest text-zinc-400">
        <span className={`h-1.5 w-1.5 rounded-full ${phase === 'live' ? 'animate-pulse bg-emerald-400' : 'bg-amber-400'}`} />
        {phase === 'live' ? 'LIVE' : 'LIH'}
      </div>
      <div className="whitespace-pre text-[15px] font-semibold leading-none tracking-wide text-emerald-300 tabular-nums">
        {primary}
        {secondary && `   ${secondary}`}
      </div>
    </div>
  )
}
