/**
 * Synthetic stenosis for the "Where's This Lesion??" mechanic. It exists only at runtime: the vessel meshes on disk are
 * never edited. The fluoro shader narrows the lumen of one branch around a point on its centerline (see lib/fluoroMaterial.ts).
 */
export type LesionMorphology = 'concentric' | 'eccentric'

export interface SyntheticLesion {
  id: string
  /** Branch id as named in the case index, e.g. "LAD", "LCx", "RCA". */
  branchName: string
  /** 0.0 to 1.0 along the branch centerline, by arc length (t = 0 at the origin of the branch). */
  normalizedPosition: number
  /** Diameter stenosis, 0.0 to 0.95 (0.85 = the lumen diameter at the waist is 15% of the normal one). */
  severity: number
  /** Length of the lesion segment in mm (the cosine taper reaches normal caliber at half this length either side). */
  lengthMm: number
  morphology: LesionMorphology
  isActive: boolean
}

export const LESION_LIMITS = {
  position: { min: 0.1, max: 0.9 },
  severity: { min: 0.5, max: 0.95 },
  /** Below ~6 mm the mesh (about two vertex rings per mm) is too coarse to carry the taper. */
  lengthMm: { min: 6, max: 20 },
} as const
