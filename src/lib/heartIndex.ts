/**
 * Sidecar index of a case (public/models/<case>.index.json, written by scripts/build-heart.mjs for the curated heart, or by
 * scripts/cohort_lib/pipeline.py for CT cohort cases), plus the library manifest (public/models/cases_manifest.json). The
 * index carries what non-GL code needs synchronously: the named coronary branches with their centerlines (LPS mm, with the
 * local lumen radius), tap hit-points and label anchors, and landmark positions (CT-derived, or placed from the heart's
 * envelope for the curated model). The meshes live in <case>.glb.
 */
export type VesselId = 'LCA' | 'RCA'
/** Which tree a centerline belongs to: an injected coronary artery system, or the cardiac veins ('VEN', Explore-only overlay, see lib/veinData.ts). */
export type BranchSystem = VesselId | 'VEN'

export interface BranchIndex {
  system: BranchSystem
  id: string
  label: string
  /** Arc-length fraction of the centerline where the label pill is anchored. */
  labelT: number
  lengthMm: number
  /** [x, y, z, lumen radius] roughly every 2 mm along the main path, origin → distal (LPS mm). */
  centerline: [number, number, number, number][]
  /** Every skeleton point of the branch group (including unnamed twigs), for tap hit-testing. */
  hit: [number, number, number][]
}

export interface CaseMeta {
  case_id: string
  frame: string
  qc_status: string
  coronary_method: string
  provisional_labels: boolean
}

export interface HeartIndex {
  version: number
  meta: CaseMeta
  branches: BranchIndex[]
  landmarks: {
    /** Lowest point of the heart, where the diaphragm dome sits (iso frame, mm). */
    diaphragm_apex: [number, number, number]
    /** Vertebral column detected in the CT (iso frame), or null when the CT did not show it credibly. */
    spine: { centres: [number, number, number][]; radius_mm: number } | null
  }
}

export interface CaseEntry {
  /** File stem under public/models, e.g. "case_2002". */
  id: string
  /** 1-based position in the library. */
  number: number
  displayName: string
  /** Display name plus the anatomical variant note, e.g. "Patient 4 - Right dominant". */
  label: string
  variantNote: string
  /** The cardiac centroid (the isocenter) in the source CT frame (LPS mm): the offset that was removed, for provenance. */
  isocenterCtLpsMm?: [number, number, number]
  landmarkBoundsMm?: {
    envelope: { min: [number, number, number]; max: [number, number, number] }
    diaphragmApex: [number, number, number]
  }
  /** Branch ids present in this case (not every case has every named branch). */
  branches: string[]
  labeling: 'curated' | 'automatic'
  provisional: boolean
}

export interface CasesManifest {
  version: number
  note: string
  default: string
  cases: CaseEntry[]
}

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/')
export const caseGlbUrl = (caseId: string) => `${base}models/${caseId}.glb`
export const caseIndexUrl = (caseId: string) => `${base}models/${caseId}.index.json`
/** Cardiac venous overlay of a case (scripts/build-veins.mjs): fetched only when the Explore "Venous" toggle is first switched on. */
export const caseVeinsGlbUrl = (caseId: string) => `${base}models/${caseId}.veins.glb`
export const caseVeinsIndexUrl = (caseId: string) => `${base}models/${caseId}.veins.index.json`
const MANIFEST_URL = `${base}models/cases_manifest.json`

export async function loadManifest(): Promise<CasesManifest> {
  const r = await fetch(MANIFEST_URL)
  if (!r.ok) throw new Error(`Could not load ${MANIFEST_URL} (${r.status})`)
  const m = (await r.json()) as CasesManifest
  if (!m.cases?.length) throw new Error('The case manifest lists no cases')
  return m
}

const indexes = new Map<string, Promise<HeartIndex>>()
const loaded = new Map<string, HeartIndex>()
let active: string | null = null

export function loadCaseIndex(caseId: string): Promise<HeartIndex> {
  let p = indexes.get(caseId)
  if (!p) {
    p = fetch(caseIndexUrl(caseId))
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ${caseIndexUrl(caseId)} (${r.status})`)
        return r.json() as Promise<HeartIndex>
      })
      .then((idx) => {
        loaded.set(caseId, idx)
        return idx
      })
    p.catch(() => indexes.delete(caseId)) // allow a retry after a network failure
    indexes.set(caseId, p)
  }
  return p
}

/** Make a case (whose index has been loaded) the one non-React code reads through getHeartIndex() / getTree(). */
export function setActiveCase(caseId: string): void {
  if (!loaded.has(caseId)) throw new Error(`Case ${caseId} accessed before its index was loaded`)
  active = caseId
}

/** Synchronous access to the active case's index once the case has been loaded. */
export function getHeartIndex(): HeartIndex {
  const idx = active ? loaded.get(active) : undefined
  if (!idx) throw new Error('Heart index accessed before a case was loaded')
  return idx
}

export const getActiveCaseId = () => active
