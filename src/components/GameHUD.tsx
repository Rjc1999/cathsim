import { useEffect, useState, type ReactNode } from 'react'
import { ArrowRight, Check, Crosshair, Eye, Flame, Footprints, Lightbulb, RotateCcw, Timer, Trophy, Volume2, VolumeX, X } from 'lucide-react'
import { formatView } from '../lib/gantry'
import type { VesselId } from '../lib/heartIndex'
import { attributionLabel, BRANCHES_BY_SYSTEM, segmentOptions } from '../lib/lesionSpawn'
import { VIEW_GOOD, type LesionViewMetrics } from '../lib/lesionView'
import { getTree, useTree } from '../lib/tree'
import { CLUE_COST, POINTS, PROJECTION_MAX_LOSS, useGameStore, type Verdict } from '../store/useGameStore'
import { useGantryStore } from '../store/useGantryStore'
import { btn, btnGhost, ViewToggles } from './HUD'

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** Seconds since the round started, ticking while the player is still playing it. */
function useElapsed(): number {
  const startedAt = useGameStore((s) => s.startedAt)
  const endedAt = useGameStore((s) => s.endedAt)
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    if (endedAt !== null) return
    const id = window.setInterval(() => setNow(performance.now()), 250)
    return () => window.clearInterval(id)
  }, [endedAt, startedAt])
  return Math.max(0, ((endedAt ?? now) - startedAt) / 1000)
}

/** Count a number up to its target over ~600 ms (the score payoff). */
function useCountUp(target: number, ms = 600): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const t0 = performance.now()
    let raf = 0
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      setV(Math.round(target * (1 - (1 - k) ** 3)))
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return v
}

function StatsBar() {
  const roundNo = useGameStore((s) => s.roundNo)
  const score = useGameStore((s) => s.score)
  const streak = useGameStore((s) => s.streak)
  const best = useGameStore((s) => s.best)
  const muted = useGameStore((s) => s.muted)
  const toggleMute = useGameStore((s) => s.toggleMute)
  const elapsed = useElapsed()
  return (
    <div className="flex items-center gap-3 rounded-xl bg-zinc-900 px-3 py-2 text-sm tabular-nums">
      <span className="font-semibold text-zinc-100">Case {roundNo}</span>
      <span className="flex items-center gap-1 text-amber-300" title={`Best round ${best.round} · best streak ${best.streak}`}>
        <Trophy size={14} aria-hidden /> {score}
      </span>
      <span className={`flex items-center gap-1 ${streak > 0 ? 'text-orange-400' : 'text-zinc-600'}`} title="Correct diagnoses in a row">
        <Flame size={14} aria-hidden /> {streak}
      </span>
      <span className="ml-auto flex items-center gap-1 font-mono text-zinc-300">
        <Timer size={14} aria-hidden /> {fmtTime(elapsed)}
      </span>
      <button
        type="button"
        onClick={toggleMute}
        aria-pressed={!muted}
        aria-label={muted ? 'Turn sound on' : 'Turn sound off'}
        className="rounded-md p-1 text-zinc-400 hover:text-zinc-100"
      >
        {muted ? <VolumeX size={16} aria-hidden /> : <Volume2 size={16} aria-hidden />}
      </button>
    </div>
  )
}

/**
 * Injection toggle. Switching keeps the angle you found (unlike Trainer, where it resets to AP). While the image is held it
 * keeps the hold, so a player who realises they are looking at the wrong coronary can inject the other one at the same pose.
 */
function InjectToggle() {
  const vessel = useGantryStore((s) => s.vessel)
  const setVessel = useGantryStore((s) => s.setVessel)
  const phase = useGameStore((s) => s.phase)
  const switchInjection = useGameStore((s) => s.switchInjection)
  const options: { id: VesselId; label: string }[] = [
    { id: 'LCA', label: 'Inject LCA' },
    { id: 'RCA', label: 'Inject RCA' },
  ]
  return (
    <div role="group" aria-label="Injected coronary" className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={vessel === o.id}
          disabled={phase === 'debrief'}
          onClick={() => (phase === 'diagnosing' ? switchInjection(o.id) : setVessel(o.id, true))}
          className={`rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors disabled:opacity-50 ${
            vessel === o.id ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Primary action dock: stays reachable at the bottom of the screen on phones, where the HUD sits below the image. */
function Dock({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-3 z-30 flex flex-col gap-2 rounded-2xl bg-zinc-950/90 p-2 ring-1 ring-white/10 backdrop-blur md:static md:bg-transparent md:p-0 md:ring-0 md:backdrop-blur-none">
      {children}
    </div>
  )
}

function Clue() {
  const clue = useGameStore((s) => s.current?.clue)
  const shown = useGameStore((s) => s.clueShown)
  const reveal = useGameStore((s) => s.revealClue)
  if (!clue) return null
  return shown ? (
    <p className="flex gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed text-amber-100">
      <Lightbulb size={14} className="mt-0.5 shrink-0 text-amber-400" aria-hidden /> {clue}
    </p>
  ) : (
    <button type="button" onClick={reveal} className={`${btnGhost} px-3 py-2 text-xs`}>
      <Lightbulb size={14} aria-hidden /> Clinical clue (−{CLUE_COST} pts)
    </button>
  )
}

function HuntPanel() {
  const freeze = useGameStore((s) => s.freeze)
  return (
    <>
      <Dock>
        <button type="button" onClick={freeze} className={`${btn} bg-rose-600 py-4 text-base text-white hover:bg-rose-500 active:bg-rose-700`}>
          <Footprints size={20} aria-hidden /> Freeze &amp; diagnose
          <kbd className="ml-1 hidden rounded bg-black/25 px-1.5 py-0.5 font-mono text-[10px] md:inline">Space</kbd>
        </button>
      </Dock>
      <InjectToggle />
      <Clue />
    </>
  )
}

/* ------------------------------------------------------------------------------------------------ console */

function Chip({ selected, disabled, onClick, title, children }: { selected: boolean; disabled?: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`min-h-11 min-w-14 rounded-xl border px-4 py-2 font-mono text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        selected
          ? 'border-sky-300 bg-sky-300 text-zinc-950'
          : 'border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100'
      }`}
    >
      {children}
    </button>
  )
}

/** Opens when the image is frozen: pick the vessel and the segment, then lock the diagnosis in. */
function DiagnosePanel() {
  const vessel = useGantryStore((s) => s.vessel)
  const guess = useGameStore((s) => s.guess)
  const selectBranch = useGameStore((s) => s.selectBranch)
  const selectSegment = useGameStore((s) => s.selectSegment)
  const lockIn = useGameStore((s) => s.lockIn)
  const unfreeze = useGameStore((s) => s.unfreeze)
  const branches = useTree(vessel)
  const names = Object.fromEntries(branches.map((b) => [b.id, b.label]))
  const complete = !!guess.branchId && !!guess.segment
  const segs = guess.branchId ? segmentOptions(guess.branchId) : []
  return (
    <>
      <Dock>
        <button
          type="button"
          disabled={!complete}
          onClick={lockIn}
          className={`${btn} bg-emerald-500 py-4 text-base text-zinc-950 hover:bg-emerald-400 active:bg-emerald-600`}
        >
          <Crosshair size={20} aria-hidden />
          {complete ? `Lock In Diagnosis · ${attributionLabel(guess.branchId!, guess.segment!)}` : 'Lock In Diagnosis'}
          <kbd className="ml-1 hidden rounded bg-black/15 px-1.5 py-0.5 font-mono text-[10px] md:inline">Enter</kbd>
        </button>
        <button type="button" onClick={unfreeze} className={`${btnGhost} py-2.5`}>
          <RotateCcw size={16} aria-hidden /> Unfreeze / keep searching
          <kbd className="ml-1 hidden rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] md:inline">Space</kbd>
        </button>
      </Dock>

      <section aria-label="Diagnosis console" className="flex flex-col gap-4 rounded-2xl border border-zinc-700 bg-zinc-900/70 p-4">
        <h2 className="text-base font-semibold text-zinc-50">Identify the diseased vessel and segment:</h2>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Injected coronary</h3>
          <InjectToggle />
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Vessel / branch</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Vessel or branch">
            {BRANCHES_BY_SYSTEM[vessel].map((id) => (
              <Chip key={id} selected={guess.branchId === id} title={names[id]} onClick={() => selectBranch(id)}>
                {id}
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Segment</h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Segment">
            {guess.branchId ? (
              segs.map((sg) => (
                <Chip key={sg} selected={guess.segment === sg} onClick={() => selectSegment(sg)}>
                  {sg}
                </Chip>
              ))
            ) : (
              <span className="text-xs text-zinc-500">Pick a vessel first.</span>
            )}
          </div>
        </div>

        <p className="text-sm text-zinc-300" aria-live="polite">
          Your call:{' '}
          <b className="font-mono text-zinc-50">{complete ? attributionLabel(guess.branchId!, guess.segment!) : guess.branchId ? `${guess.branchId} · choose a segment` : 'not yet'}</b>
        </p>
      </section>
      <Clue />
    </>
  )
}

/* ------------------------------------------------------------------------------------------------ debrief */

/** Foreshortening is the LOSS of the lesion's true length in the view (0% = seen in full profile); < 25% earns the bonus. */
function foreshorteningStyle(loss: number) {
  return loss < PROJECTION_MAX_LOSS
    ? { label: 'Well profiled', bar: 'bg-emerald-500', text: 'text-emerald-400' }
    : loss < 0.4
      ? { label: 'Moderate', bar: 'bg-amber-500', text: 'text-amber-400' }
      : { label: 'Foreshortened', bar: 'bg-rose-500', text: 'text-rose-400' }
}

function clearanceInfo(m: LesionViewMetrics, ownBranch: string) {
  const who = m.blockerId === ownBranch ? 'its own course' : (m.blockerId ?? 'another vessel')
  if (m.clearanceMm >= VIEW_GOOD.clearanceMm) {
    const mm = m.clearanceMm >= 12 ? '12+' : m.clearanceMm.toFixed(1)
    return { label: 'Clear', detail: `${mm} mm of open background`, text: 'text-emerald-400' }
  }
  if (m.clearanceMm >= 0) return { label: 'Tight', detail: `${m.clearanceMm.toFixed(1)} mm from ${who}`, text: 'text-amber-400' }
  return { label: 'Overlapped', detail: `hidden behind ${who}`, text: 'text-rose-400' }
}

function ViewColumn({ title, alpha, beta, m, ownBranch, active, note }: { title: string; alpha: number; beta: number; m: LesionViewMetrics; ownBranch: string; active: boolean; note?: string }) {
  const loss = 1 - m.foreshortening
  const fs = foreshorteningStyle(loss)
  const cl = clearanceInfo(m, ownBranch)
  return (
    <div className={`rounded-xl border p-3 ${active ? 'border-zinc-500 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/40'}`}>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{title}</div>
      <div className="mt-0.5 font-mono text-xs text-zinc-200">{formatView(alpha, beta)}</div>

      <div className="mt-3 text-[10px] uppercase tracking-widest text-zinc-500">Foreshortening</div>
      <div className={`text-xl font-bold tabular-nums ${fs.text}`}>{Math.round(loss * 100)}%</div>
      <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-zinc-800" aria-hidden>
        <span className={`block h-full rounded-full ${fs.bar}`} style={{ width: `${Math.round(m.foreshortening * 100)}%` }} />
      </span>
      <div className={`mt-1 text-[11px] ${fs.text}`}>
        {fs.label} · {Math.round(m.foreshortening * 100)}% of its length shown
      </div>

      <div className="mt-3 text-[10px] uppercase tracking-widest text-zinc-500">Overlap clearance</div>
      <div className={`text-sm font-semibold ${cl.text}`}>{cl.label}</div>
      <div className="text-[11px] leading-snug text-zinc-400">{cl.detail}</div>
      {note && <div className="mt-2 text-[11px] leading-snug text-amber-300">{note}</div>}
    </div>
  )
}

const VERDICT_STYLE: Record<Verdict, { title: string; box: string; text: string; icon: ReactNode }> = {
  correct: { title: 'Correct diagnosis', box: 'border-emerald-500/50 bg-emerald-500/5', text: 'text-emerald-400', icon: <Check size={14} aria-hidden /> },
  segment: { title: 'Right vessel, wrong segment', box: 'border-amber-500/40 bg-amber-500/5', text: 'text-amber-400', icon: <X size={14} aria-hidden /> },
  misattribution: { title: 'Misattribution', box: 'border-rose-500/50 bg-rose-500/5', text: 'text-rose-400', icon: <X size={14} aria-hidden /> },
}

function Debrief() {
  const current = useGameStore((s) => s.current)!
  const result = useGameStore((s) => s.result)!
  const viewShown = useGameStore((s) => s.viewShown)
  const showView = useGameStore((s) => s.showView)
  const next = useGameStore((s) => s.newRound)
  const best = useGameStore((s) => s.best)
  const b = result.breakdown
  const total = useCountUp(b.total)
  const own = current.lesion.branchName
  const fullName = getTree(current.system).find((x) => x.id === own)?.label ?? own
  const st = VERDICT_STYLE[result.verdict]
  const newBest = b.total > 0 && b.total >= best.round

  const sentence =
    result.verdict === 'correct'
      ? `You called ${result.guessLabel}: exactly right (${fullName}).`
      : result.verdict === 'segment'
        ? `You called ${result.guessLabel}. The branch is right (${fullName}), but the narrowing is in the ${current.truthLabel}.`
        : `Misattribution: you diagnosed ${result.guessLabel}, but the lesion is on ${fullName} (${own})${
            current.segment === 'LM Trunk' ? '' : `, in its ${current.segment.toLowerCase()} segment`
          }.`
  const rows: [string, number, string][] = [
    ['Diagnosis', b.diagnosis, result.verdict === 'correct' ? 'branch + segment' : result.verdict === 'segment' ? 'branch only' : 'wrong branch'],
    ['Projection bonus', b.projection, `foreshortening under ${Math.round(PROJECTION_MAX_LOSS * 100)}%`],
    ['Speed', b.speed, 'correct calls only'],
    ['Clue', b.clue, ''],
  ]
  const apWhy = [
    current.ap.foreshortening < 0.7 ? `its segment runs along the beam (only ${Math.round(current.ap.foreshortening * 100)}% of its length shows)` : '',
    current.ap.clearanceMm < 0.5 ? (current.ap.blockerId === own ? 'the vessel folds over it' : `the ${current.ap.blockerId} crosses over it`) : '',
  ].filter(Boolean)

  return (
    <>
      <section aria-live="polite" className={`rounded-2xl border p-4 ${st.box}`}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest ${st.text}`}>
              {st.icon} {st.title}
            </div>
            <h2 className="mt-1 text-xl font-bold text-zinc-50">{current.truthLabel}</h2>
            <p className="text-xs text-zinc-400">
              {Math.round(current.lesion.severity * 100)}% diameter stenosis · {current.lesion.lengthMm} mm · {current.lesion.morphology}
            </p>
          </div>
          <div key={total === b.total ? 'done' : 'run'} className="anim-score-pop text-right">
            <div className={`text-3xl font-black tabular-nums ${b.total > 0 ? st.text : 'text-zinc-500'}`}>+{total}</div>
            {newBest && <div className="text-[10px] font-semibold uppercase tracking-widest text-amber-300">Best round</div>}
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-zinc-200">{sentence}</p>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-400">
          <span>
            Time <b className="font-mono text-zinc-200">{fmtTime(result.seconds)}</b>
          </span>
          <span>
            Freezes <b className="text-zinc-200">{result.freezes}</b>
          </span>
        </div>
      </section>

      <Dock>
        <button type="button" onClick={next} className={`${btn} bg-zinc-100 py-4 text-base text-zinc-900 hover:bg-white`}>
          Next case <ArrowRight size={18} aria-hidden />
          <kbd className="ml-1 hidden rounded bg-black/10 px-1.5 py-0.5 font-mono text-[10px] md:inline">Space</kbd>
        </button>
      </Dock>

      <section aria-label="Projection quality" className="flex flex-col gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Projection quality</h3>
        <div className="grid grid-cols-2 gap-2">
          <ViewColumn
            title="Your frozen view"
            alpha={result.alpha}
            beta={result.beta}
            m={result.metrics}
            ownBranch={own}
            active={viewShown === 'yours'}
            note={result.visible ? undefined : `${current.system} was not injected here, so the lesion was not opacified.`}
          />
          <ViewColumn title="Best view" alpha={current.best.alpha} beta={current.best.beta} m={current.best.metrics} ownBranch={own} active={viewShown === 'best'} />
        </div>
        <div role="group" aria-label="Image shown" className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1 text-xs font-semibold">
          {(['yours', 'best'] as const).map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={viewShown === w}
              onClick={() => showView(w)}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2.5 transition-colors ${viewShown === w ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              <Eye size={14} aria-hidden /> {w === 'yours' ? 'Show my view' : 'Show best view'}
            </button>
          ))}
        </div>
        <p className="text-xs leading-relaxed text-zinc-400">
          {current.ap.score > 0.55
            ? `AP already showed this one well; the challenge here was naming the vessel. `
            : `Why AP hid it: ${apWhy.length ? apWhy.join(' and ') : 'poorly profiled'}. `}
          Only {Math.round(current.best.goodFraction * 100)}% of C-arm positions show it clearly.
        </p>
      </section>

      <section aria-label="Points">
        <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-zinc-500">Points</h3>
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-xs">
          {rows
            .filter(([, v]) => v !== 0)
            .map(([k, v, why]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-400">
                  {k}
                  {why && <span className="text-zinc-600"> · {why}</span>}
                </dt>
                <dd className={`text-right font-mono tabular-nums ${v < 0 ? 'text-rose-400' : 'text-zinc-200'}`}>{v > 0 ? `+${v}` : v}</dd>
              </div>
            ))}
          {b.total === 0 && <p className="col-span-2 text-zinc-500">No points this case. Max {POINTS.full + POINTS.projection + POINTS.speed}: {POINTS.full} diagnosis, {POINTS.projection} projection, {POINTS.speed} speed.</p>}
        </dl>
      </section>
    </>
  )
}

/** HUD for "Where's This Lesion??": hunt, diagnose, debrief. Shares the landmark / parallax toggles with Trainer. */
export function GameHUD() {
  const phase = useGameStore((s) => s.phase)
  const hasRound = useGameStore((s) => s.current !== null)
  if (!hasRound) return null
  return (
    <div
      className="flex w-full flex-col gap-4"
      // After a POINTER click, drop focus from the button so the global Space / Enter / Esc shortcuts keep working (they ignore keys
      // while a button has focus, and Space on a focused "Show best view" would press it again instead of advancing). Keyboard
      // activations (detail 0) keep focus so Tab users do not lose their place.
      onClickCapture={(e) => {
        if (e.detail > 0) (e.target as HTMLElement).closest('button')?.blur()
      }}
    >
      <StatsBar />
      {phase === 'hunt' && <HuntPanel />}
      {phase === 'diagnosing' && <DiagnosePanel />}
      {phase === 'debrief' && <Debrief />}
      <ViewToggles />
      <p className="text-xs leading-relaxed text-zinc-500">
        Drag the image to move the C-arm (right = LAO, up = cranial; two fingers = fine; double-tap = AP). Names stay hidden until you
        lock in a diagnosis.
      </p>
    </div>
  )
}
