import type { SyntheticLesion } from '../types/lesion'
import { LESION_LIMITS } from '../types/lesion'
import type { VesselId } from './heartIndex'
import {
  evaluateView,
  findBestView,
  makeLesionContext,
  type BestView,
  type LesionContext,
  type LesionSpec,
  type LesionViewMetrics,
} from './lesionView'
import { getTree } from './tree'

/** Branches a game lesion can sit on. The three main trunks come up every round; the side branches join from round 3. */
const GAME_BRANCHES: { id: string; system: VesselId; territory: string }[] = [
  { id: 'LAD', system: 'LCA', territory: 'anterior wall and septum' },
  { id: 'LCx', system: 'LCA', territory: 'lateral wall' },
  { id: 'RCA', system: 'RCA', territory: 'inferior wall' },
  { id: 'D1', system: 'LCA', territory: 'anterolateral wall' },
  { id: 'D2', system: 'LCA', territory: 'anterolateral wall' },
  { id: 'AM', system: 'RCA', territory: 'right ventricular wall' },
  { id: 'PDA', system: 'RCA', territory: 'inferior wall and inferior septum' },
]
export const TRUNK_IDS = ['LAD', 'LCx', 'RCA'] as const
export const SIDE_IDS = ['D1', 'D2', 'AM', 'PDA'] as const

/* ----------------------------------------------------------------------------------------------- attribution */

/** Every selectable branch per injected coronary system, in anatomical order (the chips of the diagnosis console). */
export const BRANCHES_BY_SYSTEM: Record<VesselId, readonly string[]> = {
  LCA: ['LM', 'LAD', 'D1', 'D2', 'S1', 'S2', 'S3', 'S4', 'LCx', 'OM1', 'OM2'],
  RCA: ['RCA', 'AM', 'PDA', 'PLB'],
}

export type SegmentLevel = 'Proximal' | 'Mid' | 'Distal' | 'LM Trunk'

/** Primary trunks split in thirds-ish (t = arc fraction of the centerline), side branches in halves, the left main is one piece. */
const TRUNK_CUTS = [0.35, 0.7] as const
const SIDE_CUT = 0.5

const isTrunk = (id: string) => (TRUNK_IDS as readonly string[]).includes(id)

/** Segment choices offered for a branch: [Proximal, Mid, Distal] for LAD / LCx / RCA, [Proximal, Distal] for side branches, [LM Trunk] for the LM. */
export function segmentOptions(branchId: string): SegmentLevel[] {
  if (branchId === 'LM') return ['LM Trunk']
  return isTrunk(branchId) ? ['Proximal', 'Mid', 'Distal'] : ['Proximal', 'Distal']
}

/** The segment of `branchId` that centerline fraction `t` falls in (trunks: t < 0.35 / <= 0.70 / > 0.70; side branches: t < 0.5 / >= 0.5). */
export function segmentOf(branchId: string, t: number): SegmentLevel {
  if (branchId === 'LM') return 'LM Trunk'
  if (isTrunk(branchId)) return t < TRUNK_CUTS[0] ? 'Proximal' : t <= TRUNK_CUTS[1] ? 'Mid' : 'Distal'
  return t < SIDE_CUT ? 'Proximal' : 'Distal'
}

/** "Mid LAD", "Distal D1", "LM Trunk". */
export const attributionLabel = (branchId: string, segment: SegmentLevel) => (segment === 'LM Trunk' ? 'LM Trunk' : `${segment} ${branchId}`)

/** Centerline fractions where the segment changes for a branch. */
const cutsFor = (branchId: string): readonly number[] => (isTrunk(branchId) ? TRUNK_CUTS : [SIDE_CUT])

export interface GameLesion {
  lesion: SyntheticLesion
  system: VesselId
  ctx: LesionContext
  /** What the neutral AP projection shows of this lesion (always poor by construction). */
  ap: LesionViewMetrics
  best: BestView
  /** The correct answer: the branch is `lesion.branchName`. */
  segment: SegmentLevel
  /** "Mid LAD". */
  truthLabel: string
  /** Simulated clinical vignette that points at a territory, not at the vessel. */
  clue: string
}

/** Deterministic PRNG (mulberry32), so `?seed=` makes a session reproducible for testing. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PATIENTS = ['58-year-old man', '64-year-old woman', '71-year-old man', '55-year-old woman', '67-year-old man', '49-year-old man']
const SYMPTOMS = ['exertional chest pressure', 'angina on climbing stairs', 'chest tightness walking uphill', 'exertional dyspnoea and jaw discomfort']

/** Difficulty ramps with the round number: severity drops from 92% to 78% (a thinner waist is harder to spot). */
export function difficultyFor(round: number, rng: () => number): { severity: number; lengthMm: number; eccentric: boolean } {
  const base = Math.max(0.78, 0.92 - 0.02 * (round - 1))
  const severity = Math.min(LESION_LIMITS.severity.max, Math.max(LESION_LIMITS.severity.min, base + (rng() - 0.5) * 0.04))
  const lengthMm = Math.round((round <= 3 ? 12 : 10) + rng() * 3)
  return { severity: +severity.toFixed(2), lengthMm, eccentric: round >= 3 && rng() < 0.35 }
}

/** A lesion is hard in AP when it is foreshortened or covered, and solvable when some pose shows it clearly. */
const AP_MAX_SCORE = 0.55
const BEST_MIN_SCORE = 0.9
const FINDABLE_RANGE = [0.05, 0.6] as const
const MAX_TRIES = 300
/** A lesion must sit at least its own half-length plus this fraction of the branch away from a segment boundary, so "Mid or Proximal?" has one answer. */
const BOUNDARY_MARGIN_T = 0.04

/** Why AP hides the lesion: its segment runs along the beam (foreshortened) or another vessel crosses it (covered). */
export type HideCause = 'foreshortened' | 'covered'

const matchesCause = (ap: LesionViewMetrics, cause: HideCause) =>
  cause === 'foreshortened' ? ap.foreshortening < 0.7 : ap.foreshortening >= 0.7 && ap.clearanceMm < 0.5

export const GAME_BRANCH_IDS = GAME_BRANCHES.map((b) => b.id)

const lengthCache = new Map<string, number>()
function branchLengthMm(system: VesselId, id: string): number {
  const key = `${system}:${id}`
  let len = lengthCache.get(key)
  if (len === undefined) {
    len = getTree(system).find((b) => b.id === id)?.curve.getLength() ?? 100
    lengthCache.set(key, len)
  }
  return len
}

/** Whether a lesion of this length centred at `t` would straddle (or crowd) a segment boundary of its branch. */
function nearBoundary(system: VesselId, id: string, t: number, lengthMm: number): boolean {
  const margin = lengthMm / 2 / branchLengthMm(system, id) + BOUNDARY_MARGIN_T
  return cutsFor(id).some((c) => Math.abs(t - c) < margin)
}

const hideableCache = new Map<string, boolean>()
/**
 * Whether the neutral AP projection can hide a lesion on this branch at all (7 probes along it). The first diagonal runs across
 * the anterior surface and is fully profiled in AP wherever it is, so it can never be an "AP hides it" case: it is an
 * attribution case instead, where the challenge is telling D1 from the LAD it runs beside.
 */
function canHideInAp(branch: (typeof GAME_BRANCHES)[number], lengthMm: number): boolean {
  const key = `${branch.system}:${branch.id}`
  let v = hideableCache.get(key)
  if (v === undefined) {
    v = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8].some(
      (t) => evaluateView(makeLesionContext({ system: branch.system, branchId: branch.id, t, lengthMm }), 0, 0).score <= AP_MAX_SCORE,
    )
    hideableCache.set(key, v)
  }
  return v
}

interface SpawnOptions {
  round: number
  rng: () => number
  /** Branch to place the lesion on (the caller keeps a shuffled bag so every vessel comes up equally often). */
  branch?: string
  /** Preferred reason AP hides it; relaxed after 60% of the draws so the game never stalls. */
  cause?: HideCause
}

/**
 * Roll a lesion on the requested branch (random position away from segment boundaries), keeping it only if AP hides it
 * (score <= 0.55, for the requested cause while that is achievable) yet some pose shows it clearly (score >= 0.9) from a
 * region that is neither a needle nor most of the sphere. After 60% of the draws the cause is relaxed, after 80% the branch
 * too; as a last resort the most AP-hidden solvable draw is used, so the game never stalls.
 */
export function spawnLesion({ round, rng, branch: wantedBranch, cause }: SpawnOptions): GameLesion {
  const diff = difficultyFor(round, rng)
  type Candidate = { branch: (typeof GAME_BRANCHES)[number]; spec: LesionSpec; ctx: LesionContext; ap: LesionViewMetrics; best: BestView }
  let fallback: Candidate | null = null
  const wanted = GAME_BRANCHES.find((b) => b.id === wantedBranch)
  // Branches AP can never hide skip the "hidden in AP" requirement (and the cause preference); solvability still applies.
  const apRule = wanted && !canHideInAp(wanted, diff.lengthMm) ? Infinity : AP_MAX_SCORE

  for (let i = 0; i < MAX_TRIES; i++) {
    const branch = wanted && i < MAX_TRIES * 0.8 ? wanted : GAME_BRANCHES[Math.floor(rng() * GAME_BRANCHES.length)]
    const t = +(0.15 + rng() * 0.7).toFixed(3)
    if (nearBoundary(branch.system, branch.id, t, diff.lengthMm)) continue
    const spec: LesionSpec = { system: branch.system, branchId: branch.id, t, lengthMm: diff.lengthMm }
    const ctx = makeLesionContext(spec)
    const ap = evaluateView(ctx, 0, 0)
    if (ap.score > apRule) continue
    if (cause && apRule === AP_MAX_SCORE && i < MAX_TRIES * 0.6 && !matchesCause(ap, cause)) continue
    const best = findBestView(ctx)
    if (best.metrics.score >= BEST_MIN_SCORE && best.goodFraction >= FINDABLE_RANGE[0] && best.goodFraction <= FINDABLE_RANGE[1]) {
      return build(branch, spec, ctx, ap, best, round, rng, diff)
    }
    if (best.metrics.score >= 0.8 && (!fallback || ap.score < fallback.ap.score)) fallback = { branch, spec, ctx, ap, best }
  }
  if (!fallback) {
    // Nothing AP-hidden and solvable turned up (should not happen on the standard heart): take any solvable lesion mid-branch.
    const branch = wanted ?? GAME_BRANCHES[0]
    const spec: LesionSpec = { system: branch.system, branchId: branch.id, t: isTrunk(branch.id) ? 0.52 : 0.28, lengthMm: diff.lengthMm }
    const ctx = makeLesionContext(spec)
    fallback = { branch, spec, ctx, ap: evaluateView(ctx, 0, 0), best: findBestView(ctx) }
  }
  return build(fallback.branch, fallback.spec, fallback.ctx, fallback.ap, fallback.best, round, rng, diff)
}

function build(
  branch: (typeof GAME_BRANCHES)[number],
  spec: LesionSpec,
  ctx: LesionContext,
  ap: LesionViewMetrics,
  best: BestView,
  round: number,
  rng: () => number,
  diff: ReturnType<typeof difficultyFor>,
): GameLesion {
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)]
  const segment = segmentOf(branch.id, spec.t)
  return {
    lesion: {
      id: `game-lesion-${round}`,
      branchName: branch.id,
      normalizedPosition: spec.t,
      // Side branches are only ~1.7-2 mm wide: keep their stenosis severe enough to read as a waist.
      severity: isTrunk(branch.id) ? diff.severity : Math.max(diff.severity, 0.9),
      lengthMm: spec.lengthMm,
      morphology: diff.eccentric ? 'eccentric' : 'concentric',
      isActive: true,
    },
    system: branch.system,
    ctx,
    ap,
    best,
    segment,
    truthLabel: attributionLabel(branch.id, segment),
    clue: `${pick(PATIENTS)}, ${pick(SYMPTOMS)}. Stress perfusion: reversible defect of the ${branch.territory}.`,
  }
}
