import { useGLTF } from '@react-three/drei'
import { create } from 'zustand'
import { findTarget, targetsFor, type TargetPreset } from '../data/targets'
import { loadCaseIndex, setActiveCase, caseGlbUrl, type CaseEntry, type VesselId } from '../lib/heartIndex'
import { preloadVeins } from '../lib/veinData'
import { angularErrorDeg, clamp, clampAlpha, clampBeta } from '../lib/gantry'

/**
 * Top-level app mode. explore: free anatomy exploration with live pro-tips (no targets, no scoring). target: match the commanded
 * projection, pedal to grade. game: "Where's This Lesion?". Switch it only through `setAppMode` (store/appMode.ts), which also
 * resets the shared gantry state and starts / stops the game round.
 */
export type AppMode = 'explore' | 'target' | 'game'

/** 'gantry': drag drives the physical C-arm arc (drag right = LAO, up = CRA). 'natural': standard 3D orbit (right = RAO, up = CAU). */
export type ControlScheme = 'gantry' | 'natural'

/** Fluoro magnification range (1.0x = the full 24 cm detector field). */
export const ZOOM_MIN = 1
export const ZOOM_MAX = 2.5
/** Table pan limit (mm, per axis): the view centre may leave the isocenter by this much, enough to bring any part of the heart to the middle. */
export const PAN_LIMIT_MM = 120

const SCHEME_KEY = 'cathsim_control_scheme'
const readScheme = (): ControlScheme => {
  try {
    return localStorage.getItem(SCHEME_KEY) === 'natural' ? 'natural' : 'gantry'
  } catch {
    return 'gantry'
  }
}
const writeScheme = (scheme: ControlScheme) => {
  try {
    localStorage.setItem(SCHEME_KEY, scheme)
  } catch {
    /* private mode / blocked storage: the choice just lasts for the session */
  }
}

/** `live`: fluoro running, the gantry can be moved. `locked`: pedal tapped, last-image-hold for inspection. */
export type Phase = 'live' | 'locked'
export type Grade = 'excellent' | 'good' | 'close' | 'off'

/** Snapshot taken when the pedal locks the view. */
export interface LockResult {
  /** Patient case the view was scored on. */
  caseId: string
  targetId: string
  alpha: number
  beta: number
  /** True spatial angular error between detector directions (deg) versus the textbook target view. */
  deltaThetaDeg: number
  /** Signed component errors (user - target), for diagnostic feedback only; never used for the grade. */
  dAlpha: number
  dBeta: number
  grade: Grade
}

/** Δθ thresholds (deg) for grading. */
export const GRADE_LIMITS: Record<Exclude<Grade, 'off'>, number> = { excellent: 5, good: 10, close: 20 }

export const gradeFor = (deltaTheta: number): Grade =>
  deltaTheta <= GRADE_LIMITS.excellent
    ? 'excellent'
    : deltaTheta <= GRADE_LIMITS.good
      ? 'good'
      : deltaTheta <= GRADE_LIMITS.close
        ? 'close'
        : 'off'

interface GantryState {
  /** Library of patient cases (from public/models/cases_manifest.json) and the one currently shown. */
  availableCases: CaseEntry[]
  currentCaseId: string
  /** Case being fetched while a switch is in flight (the previous case stays on screen meanwhile). */
  caseLoading: string | null
  caseError: string | null
  /** Live gantry pose (deg). Written at input rate, read imperatively by the cameras (no re-render needed). */
  alpha: number
  beta: number
  /** Fluoro magnification, 1.0 to 2.5 (display only, not an acquisition parameter, so it also works on a held image). */
  zoom: number
  /**
   * Table pan: where the centre of the image sits relative to the isocenter, in mm on the isocenter plane, in the OPERATOR's
   * (mirrored) screen axes: +x = towards screen-right, +y = towards screen-up. [0, 0] = isocenter in the middle. It is expressed
   * in the detector plane, so it stays put on screen while the gantry angle changes.
   */
  panOffset: [number, number]
  controlScheme: ControlScheme
  mode: AppMode
  vessel: VesselId
  targetId: string
  phase: Phase
  result: LockResult | null
  history: LockResult[]
  /** Spine + diaphragm orienting shadows in the fluoro image. */
  landmarks: boolean
  /** Branch name pills anchored on the centerlines (the user's toggle; see `labelsMode` for who currently controls visibility). */
  labels: boolean
  /**
   * Who controls label visibility. 'user': the `labels` toggle. 'hidden' / 'revealed': the lesion game forces the pills off while
   * the player is working out which vessel is diseased, and on in the debrief. Always read it through `labelsShown`.
   */
  labelsMode: 'user' | 'hidden' | 'revealed'
  /** The lesion game blocks tap-to-highlight (it would help identify vessels) until the debrief. */
  highlightLocked: boolean
  /** Branch id highlighted in both the fluoro view and the 3D twin (null = none). */
  highlightId: string | null
  /** 3D twin camera on the tube side (looking at the back of the heart) instead of the detector side. */
  twinBehind: boolean
  /**
   * Explore-only third "injection": the coronary sinus (cardiac veins) instead of the LCA / RCA. While on, the arteries are NOT drawn
   * (fluoro image, labels, chips, 3D twin) and only the veins are. Default off. Read it through `venousShown`, which also requires Explore
   * mode; `setVessel` (picking LCA / RCA), `setAppMode` and `loadCase` switch it off.
   */
  showVenousCirculation: boolean
  /** The venous model is being fetched (first switch-on only). */
  venousLoading: boolean
  venousError: string | null

  /** Called once at startup, after the manifest and the first case's index are loaded. */
  initCases: (cases: CaseEntry[], currentCaseId: string) => void
  /** Switch the patient without a page reload: fetches the GLB + index, keeps the gantry angle, drops case-specific state. */
  loadCase: (caseId: string) => Promise<void>
  setAngles: (alpha: number, beta: number) => void
  nudge: (dAlpha: number, dBeta: number) => void
  resetGantry: () => void
  setZoom: (zoom: number) => void
  setPanOffset: (offset: [number, number]) => void
  /** Zoom to `zoom` while keeping the isocenter-plane point at (`u`, `v`) mm from the image centre (screen-right / screen-up) fixed. */
  zoomAbout: (zoom: number, u: number, v: number) => void
  /** Back to AP 0 / 0, 1.0x and centred (the angles only move while the fluoro is live). */
  resetView: () => void
  setControlScheme: (scheme: ControlScheme) => void
  toggleControlScheme: () => void
  toggleLandmarks: () => void
  toggleLabels: () => void
  toggleTwinBehind: () => void
  /** Explore only: inject the coronary sinus (venous tree only, arteries hidden), fetching its model the first time, or go back to the arteries. */
  toggleVenousCirculation: () => Promise<void>
  /** Highlight a branch; passing the already highlighted id (or null) clears it. */
  toggleHighlight: (id: string | null) => void
  /** Switch the injected vessel. Resets the gantry to AP unless `keepPose` (the lesion game keeps the angle you found). */
  setVessel: (vessel: VesselId, keepPose?: boolean) => void
  selectTarget: (id: string) => void
  nextTarget: () => void
  /** Pedal tap (Target Views only): lock the current projection for inspection and score it against the textbook view. */
  lock: () => void
  /** Release the lock (gantry stays where it was). */
  resume: () => void
  /** Last-image-hold without scoring against a textbook view (no LockResult, not added to the history): the game's pedal. */
  hold: () => void
}

const firstTargetId = (vessel: VesselId) => targetsFor(vessel)[0].id

/** Whether the venous layer is drawn right now: the user's toggle, and only ever in Explore (never in Target Views or the game). */
export const venousShown = (s: Pick<GantryState, 'mode' | 'showVenousCirculation'>) => s.mode === 'explore' && s.showVenousCirculation

/** Whether the branch label pills are drawn right now. */
export const labelsShown = (s: Pick<GantryState, 'labels' | 'labelsMode'>) =>
  s.labelsMode === 'revealed' ? true : s.labelsMode === 'hidden' ? false : s.labels

export const useGantryStore = create<GantryState>()((set, get) => ({
  availableCases: [],
  currentCaseId: '',
  caseLoading: null,
  caseError: null,
  alpha: 0,
  beta: 0,
  zoom: 1,
  panOffset: [0, 0],
  controlScheme: readScheme(),
  mode: 'explore',
  vessel: 'LCA',
  targetId: firstTargetId('LCA'),
  phase: 'live',
  result: null,
  history: [],
  landmarks: true,
  labels: false,
  labelsMode: 'user',
  highlightLocked: false,
  highlightId: null,
  twinBehind: false,
  showVenousCirculation: false,
  venousLoading: false,
  venousError: null,

  initCases: (cases, currentCaseId) => set({ availableCases: cases, currentCaseId }),

  loadCase: async (caseId) => {
    const { currentCaseId, availableCases, caseLoading } = get()
    if (caseId === currentCaseId || caseId === caseLoading || !availableCases.some((c) => c.id === caseId)) return
    set({ caseLoading: caseId, caseError: null })
    try {
      // Everything the new case needs is fetched while the old one stays on screen, so the swap itself is instantaneous.
      await Promise.all([loadCaseIndex(caseId), fetch(caseGlbUrl(caseId)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${caseGlbUrl(caseId)} (${r.status})`))))])
      if (get().caseLoading !== caseId) return // a newer switch superseded this one
      useGLTF.preload(caseGlbUrl(caseId), false) // start the parse now; the canvases pick it up from drei's cache
      setActiveCase(caseId)
      // Gantry angle is kept on purpose (comparing the same projection across patients is the point). A locked view
      // belonged to the previous patient, so the fluoro resumes; the highlight names a branch that may not exist here.
      set({ currentCaseId: caseId, caseLoading: null, phase: 'live', result: null, highlightId: null, showVenousCirculation: false, venousError: null })
    } catch (e) {
      console.error(e)
      set({ caseLoading: null, caseError: `Could not load ${caseId}` })
    }
  },

  setAngles: (alpha, beta) => {
    if (get().phase !== 'live') return
    set({ alpha: clampAlpha(alpha), beta: clampBeta(beta) })
  },

  nudge: (dAlpha, dBeta) => {
    const { alpha, beta } = get()
    get().setAngles(alpha + dAlpha, beta + dBeta)
  },

  resetGantry: () => get().setAngles(0, 0),

  setZoom: (zoom) => set({ zoom: clamp(zoom, ZOOM_MIN, ZOOM_MAX) }),
  setPanOffset: ([x, y]) => set({ panOffset: [clamp(x, -PAN_LIMIT_MM, PAN_LIMIT_MM), clamp(y, -PAN_LIMIT_MM, PAN_LIMIT_MM)] }),
  zoomAbout: (zoom, u, v) => {
    const { zoom: z0, panOffset } = get()
    const z1 = clamp(zoom, ZOOM_MIN, ZOOM_MAX)
    if (z1 === z0) return
    // (u, v) is measured at the old scale; the same iso-plane point must stay under the cursor, so the centre moves by (u, v)(1 - z0/z1).
    const k = 1 - z0 / z1
    set({ zoom: z1 })
    get().setPanOffset([panOffset[0] + u * k, panOffset[1] + v * k])
  },
  resetView: () => {
    get().setAngles(0, 0)
    set({ zoom: 1, panOffset: [0, 0] })
  },

  setControlScheme: (scheme) => {
    writeScheme(scheme)
    set({ controlScheme: scheme })
  },
  toggleControlScheme: () => get().setControlScheme(get().controlScheme === 'gantry' ? 'natural' : 'gantry'),

  toggleLandmarks: () => set((s) => ({ landmarks: !s.landmarks })),
  toggleLabels: () => set((s) => (s.labelsMode === 'user' ? { labels: !s.labels } : s)),
  toggleTwinBehind: () => set((s) => ({ twinBehind: !s.twinBehind })),
  toggleVenousCirculation: async () => {
    const { mode, showVenousCirculation, venousLoading, currentCaseId } = get()
    if (mode !== 'explore' || venousLoading) return
    if (showVenousCirculation) {
      set({ showVenousCirculation: false, highlightId: null })
      return
    }
    set({ venousLoading: true, venousError: null })
    try {
      await preloadVeins(currentCaseId)
      // The user may have switched mode or patient while the model was downloading: then the layer is no longer theirs to show.
      const now = get()
      // An artery highlighted before the switch names nothing in the venous tree, so it is dropped.
      set({ venousLoading: false, ...(now.mode === 'explore' && now.currentCaseId === currentCaseId ? { showVenousCirculation: true, highlightId: null } : {}) })
    } catch (e) {
      console.error(e)
      set({ venousLoading: false, venousError: 'Could not load the venous model' })
    }
  },
  toggleHighlight: (id) =>
    set((s) => (s.highlightLocked ? s : { highlightId: id === null || id === s.highlightId ? null : id })),

  setVessel: (vessel, keepPose = false) => {
    if (vessel === get().vessel) {
      // Picking the artery that was injected before the coronary sinus: just leave the venous tree, the pose stays.
      if (get().showVenousCirculation) set({ showVenousCirculation: false, venousError: null, highlightId: null })
      return
    }
    set({
      showVenousCirculation: false,
      venousError: null,
      vessel,
      targetId: firstTargetId(vessel),
      ...(keepPose ? {} : { alpha: 0, beta: 0 }),
      phase: 'live',
      result: null,
      highlightId: null,
    })
  },

  selectTarget: (id) => {
    const target = findTarget(id)
    set({
      vessel: target.vessel,
      targetId: target.id,
      alpha: 0,
      beta: 0,
      zoom: 1,
      panOffset: [0, 0],
      phase: 'live',
      result: null,
      highlightId: null,
    })
  },

  nextTarget: () => {
    const { vessel, targetId } = get()
    const list = targetsFor(vessel)
    const i = list.findIndex((t) => t.id === targetId)
    get().selectTarget(list[(i + 1) % list.length].id)
  },

  lock: () => {
    const { alpha, beta, targetId, phase, history, mode } = get()
    if (phase !== 'live' || mode !== 'target') return
    const target: TargetPreset = findTarget(targetId)
    const deltaThetaDeg = angularErrorDeg(alpha, beta, target.alpha, target.beta)
    const result: LockResult = {
      caseId: get().currentCaseId,
      targetId,
      alpha,
      beta,
      deltaThetaDeg,
      dAlpha: alpha - target.alpha,
      dBeta: beta - target.beta,
      grade: gradeFor(deltaThetaDeg),
    }
    set({ phase: 'locked', result, history: [...history, result] })
  },

  resume: () => set({ phase: 'live', result: null }),

  hold: () => set((s) => (s.phase === 'live' ? { phase: 'locked', result: null } : s)),
}))
