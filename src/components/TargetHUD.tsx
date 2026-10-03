import { useMemo } from 'react'
import { ArrowRight, Crosshair, Footprints, Lock, RotateCcw } from 'lucide-react'
import { findTarget, targetsFor, type TargetPreset } from '../data/targets'
import { formatView } from '../lib/gantry'
import { getTree } from '../lib/tree'
import { analyzeView, OVERLAP_HEAVY, type ForeshorteningClass, type ViewAnalysis } from '../lib/viewMetrics'
import { useGantryStore, type Grade, type LockResult } from '../store/useGantryStore'
import { btn, ViewToggles, VesselToggle } from './HUD'
import { TargetPreview } from './TargetPreview'

const GRADE_STYLE: Record<Grade, { label: string; text: string; ring: string }> = {
  excellent: { label: 'Excellent', text: 'text-emerald-400', ring: 'border-emerald-500/50' },
  good: { label: 'Good', text: 'text-sky-400', ring: 'border-sky-500/50' },
  close: { label: 'Close', text: 'text-amber-400', ring: 'border-amber-500/50' },
  off: { label: 'Off target', text: 'text-rose-400', ring: 'border-rose-500/50' },
}

const FORESHORTENING_STYLE: Record<ForeshorteningClass, { label: string; bar: string; text: string }> = {
  open: { label: 'Well profiled', bar: 'bg-emerald-500', text: 'text-emerald-400' },
  moderate: { label: 'Moderate', bar: 'bg-amber-500', text: 'text-amber-400' },
  foreshortened: { label: 'Foreshortened', bar: 'bg-rose-500', text: 'text-rose-400' },
}

function TargetPicker() {
  const vessel = useGantryStore((s) => s.vessel)
  const targetId = useGantryStore((s) => s.targetId)
  const selectTarget = useGantryStore((s) => s.selectTarget)
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Target view">
      {targetsFor(vessel).map((t) => (
        <button
          key={t.id}
          type="button"
          aria-pressed={t.id === targetId}
          onClick={() => selectTarget(t.id)}
          className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
            t.id === targetId
              ? 'border-zinc-300 bg-zinc-100 text-zinc-900'
              : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
          }`}
        >
          {t.name}
        </button>
      ))}
    </div>
  )
}

/** Signed component error (user - target) → plain-language directive. Diagnostic only; the grade is the true Δθ. */
function componentHint(d: number, positive: string, negative: string, axis: string): string {
  const mag = Math.round(Math.abs(d))
  if (mag < 1) return `${axis}: on target`
  // d < 0 means the user stopped short of the positive direction, so they needed more of it.
  return `${axis}: needs ${mag}° more ${d < 0 ? positive : negative}`
}

interface Finding {
  tone: 'good' | 'warn' | 'bad'
  text: string
}

/** Judge how well the locked projection profiles the branches this textbook view is meant to show. */
function assess(target: TargetPreset, analysis: ViewAnalysis): Finding[] {
  const findings: Finding[] = []
  const present = new Set(analysis.foreshortening.map((f) => f.id))
  const available = target.focus.filter((id) => present.has(id))
  if (available.length === 0) {
    // This case may lack some textbook branches (e.g. no PDA / PLB identified): never report them as "well profiled".
    return [{ tone: 'warn', text: `None of this view's target branches (${target.focus.join(', ')}) exist in this case.` }]
  }
  const focus = new Set(available)
  for (const f of analysis.foreshortening) {
    if (!focus.has(f.id)) continue
    const pct = Math.round(f.ratio * 100)
    if (f.cls === 'foreshortened') findings.push({ tone: 'bad', text: `${f.id} is foreshortened (${pct}% of its true length).` })
    else if (f.cls === 'moderate') findings.push({ tone: 'warn', text: `${f.id} is moderately foreshortened (${pct}%).` })
  }
  for (const o of analysis.overlaps) {
    if (focus.has(o.a) && focus.has(o.b) && o.fraction >= OVERLAP_HEAVY) {
      findings.push({ tone: 'bad', text: `${o.a} and ${o.b} overlap (${Math.round(o.fraction * 100)}% hidden).` })
    }
  }
  if (findings.length === 0) {
    findings.push({ tone: 'good', text: `${available.join(', ')} well profiled and separated in this projection.` })
  }
  return findings
}

const TONE_TEXT: Record<Finding['tone'], string> = { good: 'text-emerald-400', warn: 'text-amber-400', bad: 'text-rose-400' }

/**
 * Lock-and-inspect assessment of the frozen projection: alignment with the textbook view (true Δθ), foreshortening
 * of every branch, and which branches overlap. All derived from the centerline samples (lib/viewMetrics.ts).
 */
function InspectionCard({ result }: { result: LockResult }) {
  const vessel = useGantryStore((s) => s.vessel)
  const target = findTarget(result.targetId)
  const style = GRADE_STYLE[result.grade]
  const analysis = useMemo(() => analyzeView(getTree(vessel), result.alpha, result.beta), [vessel, result])
  const findings = useMemo(() => assess(target, analysis), [target, analysis])
  const focus = new Set(target.focus)

  return (
    <section aria-live="polite" aria-label="Projection assessment" className="rounded-2xl border border-zinc-700 bg-zinc-900/70 p-4">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-amber-400">
        <Lock size={13} aria-hidden /> Locked · {formatView(result.alpha, result.beta)}
      </div>

      {/* Alignment with the textbook view */}
      <div className={`mt-3 rounded-xl border p-3 ${style.ring}`}>
        <div className="flex items-baseline justify-between">
          <span className="text-xs text-zinc-400">vs {target.name}</span>
          <span className={`text-sm font-semibold ${style.text}`}>{style.label}</span>
        </div>
        <div className={`text-2xl font-bold tabular-nums ${style.text}`}>Δθ {result.deltaThetaDeg.toFixed(1)}°</div>
        <div className="mt-1 text-xs text-zinc-400">
          Textbook <span className="font-mono text-zinc-300">{formatView(target.alpha, target.beta)}</span>
        </div>
        <ul className="mt-1.5 space-y-0.5 text-xs text-zinc-300">
          <li>{componentHint(result.dAlpha, 'LAO', 'RAO', 'Primary')}</li>
          <li>{componentHint(result.dBeta, 'cranial', 'caudal', 'Secondary')}</li>
        </ul>
      </div>

      {/* Foreshortening */}
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">Foreshortening</h3>
      <ul className="mt-1.5 space-y-1.5">
        {analysis.foreshortening.map((f) => {
          const st = FORESHORTENING_STYLE[f.cls]
          return (
            <li key={f.id} className="grid grid-cols-[3.2rem_minmax(1.5rem,1fr)_auto] items-center gap-2 text-xs">
              <span className={`font-mono ${focus.has(f.id) ? 'font-bold text-zinc-100' : 'text-zinc-400'}`}>
                {f.id}
                {focus.has(f.id) && <span aria-label="target segment"> ★</span>}
              </span>
              <span className="h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
                <span className={`block h-full rounded-full ${st.bar}`} style={{ width: `${Math.round(f.ratio * 100)}%` }} />
              </span>
              <span className={`whitespace-nowrap text-right tabular-nums ${st.text}`}>
                {Math.round(f.ratio * 100)}% · {st.label}
              </span>
            </li>
          )
        })}
      </ul>

      {/* Branch separation */}
      <h3 className="mt-4 text-xs font-semibold uppercase tracking-widest text-zinc-500">Branch separation</h3>
      {analysis.overlaps.length === 0 ? (
        <p className="mt-1.5 text-xs text-emerald-400">All branches clearly separated.</p>
      ) : (
        <ul className="mt-1.5 space-y-0.5 text-xs">
          {analysis.overlaps.slice(0, 5).map((o) => (
            <li key={`${o.a}-${o.b}`} className={o.cls === 'overlapped' ? 'text-rose-400' : 'text-amber-400'}>
              <span className="font-mono">
                {o.a} ↔ {o.b}
              </span>{' '}
              · {Math.round(o.fraction * 100)}% hidden ({o.cls === 'overlapped' ? 'overlapped' : 'partial'})
            </li>
          ))}
        </ul>
      )}

      {/* Verdict for this textbook view */}
      <div className="mt-4 space-y-1 border-t border-zinc-800 pt-3 text-xs leading-relaxed">
        {findings.map((f) => (
          <p key={f.text} className={TONE_TEXT[f.tone]}>
            {f.text}
          </p>
        ))}
        <p className="pt-1 text-zinc-400">
          <span className="font-semibold text-zinc-300">{target.name}.</span> {target.note}
        </p>
      </div>
    </section>
  )
}


/** The commanded projection, in the clinical idiom: "Match the Spider view (LAO 45° / CAU 30°)". */
function TargetPrompt() {
  const target = findTarget(useGantryStore((s) => s.targetId))
  return (
    <section aria-label="Target prompt" className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-amber-400">
        <Crosshair size={13} aria-hidden /> Prompt
      </div>
      <p className="mt-1 text-sm font-semibold leading-snug text-amber-50">
        Match the {target.name} ({formatView(target.alpha, target.beta)})
      </p>
    </section>
  )
}

/**
 * Target Views HUD: the prompt on top, the pedal (lock and grade against the textbook view, true Δθ) with the full assessment card,
 * and at the bottom the target thumbnail, the target selector and Next Target.
 */
export function TargetHUD() {
  const phase = useGantryStore((s) => s.phase)
  const result = useGantryStore((s) => s.result)
  const targetId = useGantryStore((s) => s.targetId)
  const history = useGantryStore((s) => s.history)
  const { lock, resume, nextTarget } = useGantryStore.getState()
  const live = phase === 'live'
  const best = history.length ? Math.min(...history.map((h) => h.deltaThetaDeg)) : null

  return (
    <div className="flex w-full flex-col gap-4">
      <TargetPrompt />
      <VesselToggle />

      {live ? (
        <button type="button" onClick={lock} className={`${btn} bg-rose-600 py-4 text-base text-white hover:bg-rose-500 active:bg-rose-700`}>
          <Footprints size={20} aria-hidden /> Pedal tap · lock &amp; grade
        </button>
      ) : (
        result && (
          <>
            <InspectionCard result={result} />
            <button type="button" onClick={resume} className={`${btn} border border-zinc-700 text-zinc-200 hover:border-zinc-500`}>
              <RotateCcw size={18} aria-hidden /> Resume fluoro
            </button>
          </>
        )
      )}

      <ViewToggles />

      <div className="grid grid-cols-[minmax(0,9rem)_1fr] items-start gap-4">
        <TargetPreview target={findTarget(targetId)} />
        <div className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Target view</h2>
          <TargetPicker />
          <button type="button" onClick={nextTarget} className={`${btn} bg-zinc-100 py-2 text-zinc-900 hover:bg-white`}>
            Next Target <ArrowRight size={16} aria-hidden />
          </button>
          {history.length > 0 && best !== null && (
            <p className="text-xs text-zinc-500">
              {history.length} locked · best Δθ {best.toFixed(1)}°
            </p>
          )}
        </div>
      </div>
      {live && (
        <p className="text-xs leading-relaxed text-zinc-500">
          Match the target frame using the live gantry readout, then tap the pedal to lock the image and see how well the view
          profiles the vessels.
        </p>
      )}
    </div>
  )
}
