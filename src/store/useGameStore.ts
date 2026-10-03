import { create } from 'zustand'
import { targetsFor } from '../data/targets'
import { clamp } from '../lib/gantry'
import type { VesselId } from '../lib/heartIndex'
import {
  attributionLabel,
  BRANCHES_BY_SYSTEM,
  GAME_BRANCH_IDS,
  makeRng,
  segmentOptions,
  spawnLesion,
  SIDE_IDS,
  TRUNK_IDS,
  type GameLesion,
  type HideCause,
  type SegmentLevel,
} from '../lib/lesionSpawn'
import { evaluateView, type LesionViewMetrics } from '../lib/lesionView'
import { sfx, isMuted, setMuted } from '../lib/sfx'
import { useGantryStore } from './useGantryStore'
import { useLesionStore } from './useLesionStore'

/**
 * "Where's This Lesion??" game state. An anatomical attribution challenge: Hunt (steer the C-arm; branch labels are hidden and
 * tap-to-highlight is off, so the vessel has to be recognised from its course and the spine / diaphragm landmarks) -> Freeze
 * (pedal; the image is held and the diagnosis console opens) -> Lock in diagnosis (branch + segment) -> Reveal & debrief.
 * The lesion itself lives in useLesionStore (so the existing shader renders it); this store owns the round, the judging and
 * the score. The pointer never picks anything on the image any more: the answer is given with chips.
 */
export type GamePhase = 'hunt' | 'diagnosing' | 'debrief'
/** correct: branch AND segment right. segment: right branch, wrong segment level. misattribution: wrong branch. */
export type Verdict = 'correct' | 'segment' | 'misattribution'

export const CLUE_COST = 10
/** Points: full diagnosis 70, branch only 35; +20 for profiling the lesion with < 25% foreshortening; up to +10 for speed. */
export const POINTS = { full: 70, branchOnly: 35, projection: 20, speed: 10 } as const
/** Projection bonus threshold: the frozen view may lose less than this fraction of the lesion's true length. */
export const PROJECTION_MAX_LOSS = 0.25

export interface Guess {
  branchId: string | null
  segment: SegmentLevel | null
}

export interface ScoreBreakdown {
  diagnosis: number
  projection: number
  speed: number
  clue: number
  total: number
}

export interface RoundResult {
  verdict: Verdict
  guessLabel: string
  seconds: number
  /** How many times the image was frozen before the diagnosis was locked in. */
  freezes: number
  /** The pose the diagnosis was locked in at, and what that projection shows of the lesion. */
  alpha: number
  beta: number
  metrics: LesionViewMetrics
  /** Fraction of the lesion's true length lost to foreshortening in that view (0 = seen in full profile). */
  loss: number
  /** False when the lesion's own coronary system was not the one injected at lock-in (it was not opacified). */
  visible: boolean
  breakdown: ScoreBreakdown
}

interface Bests {
  round: number
  streak: number
}

const BEST_KEY = 'cathsim.lesion.best'
function loadBests(): Bests {
  try {
    const b = JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') as Partial<Bests>
    return { round: Number(b.round) || 0, streak: Number(b.streak) || 0 }
  } catch {
    return { round: 0, streak: 0 }
  }
}
function saveBests(b: Bests) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b))
  } catch {
    /* storage unavailable: bests just do not persist */
  }
}

const clamp01 = (v: number) => clamp(v, 0, 1)

/**
 * <= 100 points. Diagnosis: 70 for branch + segment, 35 for the right branch with the wrong segment, 0 for a misattribution.
 * Projection: +20 when the branch is right (the player found the lesion) and the frozen view shows it with < 25% foreshortening
 * while its coronary system is injected. Speed: up to +10 on a fully correct call (full marks under 30 s, none after 120 s).
 * Using the clinical clue costs 10 (the total never goes below 0).
 */
export function scoreRound(verdict: Verdict, projectionOk: boolean, seconds: number, clueUsed: boolean): ScoreBreakdown {
  const diagnosis = verdict === 'correct' ? POINTS.full : verdict === 'segment' ? POINTS.branchOnly : 0
  const projection = verdict !== 'misattribution' && projectionOk ? POINTS.projection : 0
  const speed = verdict === 'correct' ? Math.round(POINTS.speed * clamp01(1 - (seconds - 30) / 90)) : 0
  const clue = clueUsed ? -CLUE_COST : 0
  return { diagnosis, projection, speed, clue, total: Math.max(0, diagnosis + projection + speed + clue) }
}

let tweenRaf = 0
/** Ease the C-arm to a pose by writing the store directly (the lock only guards user input, not this animation). */
function tweenGantry(toAlpha: number, toBeta: number) {
  cancelAnimationFrame(tweenRaf)
  const from = useGantryStore.getState()
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  const ms = reduce ? 1 : 750
  const t0 = performance.now()
  const step = (now: number) => {
    const k = clamp01((now - t0) / ms)
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
    useGantryStore.setState({ alpha: from.alpha + (toAlpha - from.alpha) * e, beta: from.beta + (toBeta - from.beta) * e })
    if (k < 1) tweenRaf = requestAnimationFrame(step)
  }
  tweenRaf = requestAnimationFrame(step)
}

function shuffled<T>(xs: T[], rng: () => number): T[] {
  const a = [...xs]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function seedFromUrl(): number {
  const raw = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('seed') : null
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) ? n : Date.now()
}

interface GameState {
  phase: GamePhase
  roundNo: number
  current: GameLesion | null
  /** The player's working diagnosis in the console (kept if they unfreeze and freeze again). */
  guess: Guess
  freezes: number
  clueShown: boolean
  result: RoundResult | null
  viewShown: 'yours' | 'best'
  startedAt: number
  endedAt: number | null
  score: number
  streak: number
  solved: number
  played: number
  best: Bests
  muted: boolean

  /** Start the game (first round). Called by `setAppMode` after it has switched the app mode to 'game'. */
  enter: () => void
  /** Stop the game and drop its lesion. The shared gantry state is reset by `setAppMode`. */
  exit: () => void
  newRound: () => void
  /** Pedal: hold the image and open the diagnosis console. */
  freeze: () => void
  /** Back to the live image to keep searching (no penalty). */
  unfreeze: () => void
  selectBranch: (id: string) => void
  selectSegment: (segment: SegmentLevel) => void
  /** Switch the injected coronary system while the image is held (keeps the pose and the hold). */
  switchInjection: (system: VesselId) => void
  /** Commit the diagnosis (needs a branch and a segment) and reveal. */
  lockIn: () => void
  revealClue: () => void
  showView: (which: 'yours' | 'best') => void
  toggleMute: () => void
}

const rng = makeRng(seedFromUrl())
let bag: string[] = []

const NO_GUESS: Guess = { branchId: null, segment: null }

/** Everything the game takes away from the user while a round is being worked: label pills and tap-to-highlight. */
const HUNT_GANTRY = { labelsMode: 'hidden', highlightLocked: true, highlightId: null } as const

export const useGameStore = create<GameState>()((set, get) => ({
  phase: 'hunt',
  roundNo: 0,
  current: null,
  guess: NO_GUESS,
  freezes: 0,
  clueShown: false,
  result: null,
  viewShown: 'yours',
  startedAt: 0,
  endedAt: null,
  score: 0,
  streak: 0,
  solved: 0,
  played: 0,
  best: loadBests(),
  muted: isMuted(),

  enter: () => get().newRound(),

  exit: () => {
    cancelAnimationFrame(tweenRaf)
    // Leaving the game: no lesion at all. Labels / highlight / pose are reset by setAppMode.
    useLesionStore.getState().setLesion(null)
    set({ phase: 'hunt', current: null, guess: NO_GUESS, result: null })
  },

  newRound: () => {
    cancelAnimationFrame(tweenRaf)
    // On a phone the debrief is long: the player has scrolled down to read it, so bring the new image back into view.
    if (typeof window !== 'undefined' && window.scrollY > 0) {
      const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
      window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    }
    const roundNo = get().roundNo + 1
    if (bag.length === 0) {
      // Every round the three trunks; from round 3 two side branches (D1, D2, AM, PDA) join the bag.
      bag = shuffled([...TRUNK_IDS, ...(roundNo >= 3 ? shuffled([...SIDE_IDS], rng).slice(0, 2) : [])], rng)
      // never the same vessel twice in a row across a bag boundary
      if (bag.length > 1 && bag[bag.length - 1] === get().current?.lesion.branchName) bag.reverse()
    }
    const branch = bag.pop()!
    const cause: HideCause = rng() < 0.4 ? 'foreshortened' : 'covered'
    const g = spawnLesion({ round: roundNo, rng, branch: GAME_BRANCH_IDS.includes(branch) ? branch : undefined, cause })
    useLesionStore.getState().setLesion(g.lesion)
    // Start neutral: LCA injected, AP, live, no names anywhere. Which vessel carries the lesion is for the player to find.
    useGantryStore.setState({
      vessel: 'LCA',
      targetId: targetsFor('LCA')[0].id,
      alpha: 0,
      beta: 0,
      zoom: 1,
      panOffset: [0, 0],
      phase: 'live',
      result: null,
      ...HUNT_GANTRY,
    })
    set({
      phase: 'hunt',
      roundNo,
      current: g,
      guess: NO_GUESS,
      freezes: 0,
      clueShown: false,
      result: null,
      viewShown: 'yours',
      startedAt: performance.now(),
      endedAt: null,
    })
  },

  freeze: () => {
    if (get().phase !== 'hunt') return
    useGantryStore.getState().hold()
    set((s) => ({ phase: 'diagnosing', freezes: s.freezes + 1 }))
    sfx.freeze()
  },

  unfreeze: () => {
    if (get().phase !== 'diagnosing') return
    useGantryStore.getState().resume()
    set({ phase: 'hunt' })
  },

  selectBranch: (id) => {
    if (get().phase !== 'diagnosing') return
    set({ guess: { branchId: id, segment: id === 'LM' ? 'LM Trunk' : null } })
    sfx.tick()
  },

  selectSegment: (segment) => {
    const { phase, guess } = get()
    if (phase !== 'diagnosing' || !guess.branchId || !segmentOptions(guess.branchId).includes(segment)) return
    set({ guess: { ...guess, segment } })
    sfx.tick()
  },

  switchInjection: (system) => {
    if (get().phase !== 'diagnosing') return
    const gantry = useGantryStore.getState()
    if (gantry.vessel === system) return
    // setVessel releases the hold (it is built for live use), so take the hold again straight away: same pose, other tree.
    gantry.setVessel(system, true)
    useGantryStore.getState().hold()
    const { guess } = get()
    if (guess.branchId && !BRANCHES_BY_SYSTEM[system].includes(guess.branchId)) set({ guess: NO_GUESS })
    sfx.tick()
  },

  lockIn: () => {
    const s = get()
    const { guess, current: g } = s
    if (s.phase !== 'diagnosing' || !g || !guess.branchId || !guess.segment) return
    const gantry = useGantryStore.getState()
    const { alpha, beta } = gantry
    const metrics = evaluateView(g.ctx, alpha, beta)
    const verdict: Verdict =
      guess.branchId !== g.lesion.branchName ? 'misattribution' : guess.segment === g.segment ? 'correct' : 'segment'
    const visible = gantry.vessel === g.system
    const loss = 1 - metrics.foreshortening
    const endedAt = performance.now()
    const seconds = (endedAt - s.startedAt) / 1000
    const breakdown = scoreRound(verdict, visible && loss < PROJECTION_MAX_LOSS, seconds, s.clueShown)
    const streak = verdict === 'correct' ? s.streak + 1 : 0
    const best = { round: Math.max(s.best.round, breakdown.total), streak: Math.max(s.best.streak, streak) }
    if (best.round !== s.best.round || best.streak !== s.best.streak) saveBests(best)
    set({
      phase: 'debrief',
      endedAt,
      result: {
        verdict,
        guessLabel: attributionLabel(guess.branchId, guess.segment),
        seconds,
        freezes: s.freezes,
        alpha,
        beta,
        metrics,
        loss,
        visible,
        breakdown,
      },
      viewShown: 'yours',
      score: s.score + breakdown.total,
      streak,
      solved: s.solved + (verdict === 'correct' ? 1 : 0),
      played: s.played + 1,
      best,
    })
    // The reveal: names come back, tap-to-highlight returns, the culprit lights up, and a missed round that ended on the other
    // injection switches to the lesion's own vessel system so the target ring has a vessel to sit on.
    useGantryStore.setState({
      vessel: g.system,
      targetId: targetsFor(g.system)[0].id,
      highlightId: g.lesion.branchName,
      labelsMode: 'revealed',
      highlightLocked: false,
    })
    sfx.commit()
    window.setTimeout(() => (verdict === 'correct' ? sfx.success() : verdict === 'segment' ? sfx.miss() : sfx.fail()), 140)
  },

  revealClue: () => set({ clueShown: true }),

  showView: (which) => {
    const { phase, current, result } = get()
    if (phase !== 'debrief' || !current || !result) return
    set({ viewShown: which })
    if (which === 'best') tweenGantry(current.best.alpha, current.best.beta)
    else tweenGantry(result.alpha, result.beta)
  },

  toggleMute: () => {
    setMuted(!isMuted())
    set({ muted: isMuted() })
  },
}))
