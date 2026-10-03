import type { VesselId } from '../lib/heartIndex'

/**
 * Textbook target views. Angles are conventional values (alpha: +LAO/-RAO, beta: +CRA/-CAU).
 * NOTE: they are not yet calibrated against this model's coronary anatomy (codominant, so the optimal view for a given
 * segment differs from the textbook value); `note` describes the clinical purpose of each view and `focus` lists the branches it is meant to profile.
 */
export interface TargetPreset {
  id: string
  vessel: VesselId
  name: string
  alpha: number
  beta: number
  note: string
  /** Branch ids this view is meant to profile (used by the lock-and-inspect assessment). */
  focus: string[]
}

export const TARGETS: readonly TargetPreset[] = [
  {
    id: 'lca-spider',
    vessel: 'LCA',
    name: 'Spider view',
    alpha: 45,
    beta: -30,
    note: 'LAO caudal. Opens the LM bifurcation and separates the proximal LAD from the LCx.',
    focus: ['LM', 'LAD', 'LCx'],
  },
  {
    id: 'lca-rao-caudal',
    vessel: 'LCA',
    name: 'RAO caudal',
    alpha: -30,
    beta: -25,
    note: 'Best for the LCx and OM branches, and for the proximal LAD, which is foreshortened elsewhere.',
    focus: ['LCx', 'OM1', 'LAD'],
  },
  {
    id: 'lca-ap-cranial',
    vessel: 'LCA',
    name: 'AP cranial',
    alpha: 0,
    beta: 30,
    note: 'Elongates the mid/distal LAD and spreads the diagonals away from it.',
    focus: ['LAD', 'D1'],
  },
  {
    id: 'lca-lao-cranial',
    vessel: 'LCA',
    name: 'LAO cranial',
    alpha: 30,
    beta: 30,
    note: 'Profiles the ostial/mid LAD and separates the diagonals and septal perforators.',
    focus: ['LAD', 'D1'],
  },
  {
    id: 'lca-rao-cranial',
    vessel: 'LCA',
    name: 'RAO cranial',
    alpha: -30,
    beta: 20,
    note: 'Mid and distal LAD, with the diagonals fanned out to the side.',
    focus: ['LAD', 'D1'],
  },
  {
    id: 'rca-lao',
    vessel: 'RCA',
    name: 'LAO (RCA)',
    alpha: 40,
    beta: 0,
    note: 'Standard RCA view. The C-loop opens up and the ostium to mid vessel is shown well.',
    focus: ['RCA'],
  },
  {
    id: 'rca-rao',
    vessel: 'RCA',
    name: 'RAO (RCA)',
    alpha: -30,
    beta: 0,
    note: 'Shows the mid RCA and the acute marginal in profile, and the PDA origin near the crux.',
    focus: ['RCA', 'AM', 'PDA'],
  },
  {
    id: 'rca-lao-cranial',
    vessel: 'RCA',
    name: 'LAO cranial (RCA)',
    alpha: 30,
    beta: 30,
    note: 'Opens the distal bifurcation. Separates the PDA from the PLB at the crux.',
    focus: ['PDA', 'PLB'],
  },
  {
    id: 'rca-ap-cranial',
    vessel: 'RCA',
    name: 'AP cranial (RCA)',
    alpha: 0,
    beta: 30,
    note: 'Distal RCA, PDA and PLB, with less overlap from the spine and the diaphragm.',
    focus: ['PDA', 'PLB'],
  },
]

export const targetsFor = (vessel: VesselId) => TARGETS.filter((t) => t.vessel === vessel)
export const findTarget = (id: string) => TARGETS.find((t) => t.id === id) ?? TARGETS[0]
