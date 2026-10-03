import { makeProjector } from '../lib/projection'
import { verdictTone } from '../lib/verdictTone'
import { useGameStore } from '../store/useGameStore'
import { useGantryStore } from '../store/useGantryStore'

/** The reveal ring on the real lesion: converges in, then idles as a slowly rotating dashed lock. `x`, `y` are % of the view. */
export function LockRing({ x, y, tone, label, small = false }: { x: number; y: number; tone: string; label: string; small?: boolean }) {
  const size = small ? 38 : 76
  return (
    <div className="anim-lock-converge absolute" style={{ left: `${x}%`, top: `${y}%` }}>
      <svg width={size} height={size} viewBox="-38 -38 76 76" className="block overflow-visible" aria-hidden>
        <g className="anim-ring-spin" style={{ transformOrigin: '0 0' }}>
          <circle r="30" fill="none" stroke={tone} strokeWidth="2.2" strokeDasharray="10 7" strokeLinecap="round" />
        </g>
        <circle r="22" fill="none" stroke={tone} strokeWidth="1.2" opacity="0.6" />
        <path d="M0 -37v10 M0 37v-10 M-37 0h10 M37 0h-10" stroke={tone} strokeWidth="2.4" strokeLinecap="round" />
      </svg>
      {!small && (
      <span
        className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] font-semibold leading-tight ring-1"
        style={{ color: tone, ['--tw-ring-color' as string]: tone, [y > 78 ? 'bottom' : 'top']: 42 }}
      >
        {label}
      </span>
      )}
    </div>
  )
}

function Burst({ x, y, tone }: { x: number; y: number; tone: string }) {
  return (
    <>
      {[0, 120, 240].map((delay) => (
        <span
          key={delay}
          className="anim-lock-burst absolute h-16 w-16 rounded-full border-2"
          style={{ left: `${x}%`, top: `${y}%`, borderColor: tone, animationDelay: `${delay}ms` }}
        />
      ))}
    </>
  )
}

function Reveal() {
  const alpha = useGantryStore((s) => s.alpha)
  const beta = useGantryStore((s) => s.beta)
  const zoom = useGantryStore((s) => s.zoom)
  const pan = useGantryStore((s) => s.panOffset)
  const current = useGameStore((s) => s.current)
  const result = useGameStore((s) => s.result)
  const roundNo = useGameStore((s) => s.roundNo)
  if (!current || !result) return null
  // Pure-math projection (lib/projection.ts): the ring stays on the lesion even while "Show best view" animates the C-arm.
  const [x, y] = makeProjector(alpha, beta, zoom, pan)(current.ctx.centre)
  const tone = verdictTone(result.verdict)
  return (
    <>
      {result.verdict === 'correct' && (
        <>
          <div key={`flash${roundNo}`} className="anim-lock-flash absolute inset-0" style={{ background: `radial-gradient(circle at ${x}% ${y}%, rgba(52,211,153,0.55), transparent 60%)` }} />
          <Burst key={`burst${roundNo}`} x={x} y={y} tone={tone} />
        </>
      )}
      <LockRing key={`lock${roundNo}`} x={x} y={y} tone={tone} label={`${current.truthLabel} · ${Math.round(current.lesion.severity * 100)}%`} />
    </>
  )
}

/**
 * Game layer inside the fluoro aperture (same box as the branch labels, so percentages line up with the image). It only exists
 * for the reveal: while hunting and diagnosing the image carries nothing but anatomy.
 */
export function GameOverlay() {
  const reveal = useGameStore((s) => s.phase === 'debrief')
  if (!reveal) return null
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <Reveal />
    </div>
  )
}
