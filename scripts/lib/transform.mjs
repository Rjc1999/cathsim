/**
 * Model → patient LPS (mm). The FBX is Y-up with +X = patient left and +Z = anterior (verified from axis renders:
 * from +Z the anterior surface faces the viewer, the arch points up and the apex points to +X).
 * LPS: +X left, +Y posterior, +Z cranial  ⇒  (x, y, z) → (x, -z, y)  (a proper rotation, det = +1).
 */
export const MODEL_TO_MM = 0.55

export function makeTransform(centerModel) {
  const [cx, cy, cz] = centerModel
  return {
    point: (x, y, z) => [MODEL_TO_MM * (x - cx), MODEL_TO_MM * -(z - cz), MODEL_TO_MM * (y - cy)],
    /** Column-major 4x4 for three.js (Matrix4.fromArray): p_lps = M · p_model. */
    matrix: [
      MODEL_TO_MM, 0, 0, 0,
      0, 0, MODEL_TO_MM, 0,
      0, -MODEL_TO_MM, 0, 0,
      -MODEL_TO_MM * cx, MODEL_TO_MM * cz, -MODEL_TO_MM * cy, 1,
    ],
  }
}

/** Volume centroid of a closed welded triangle mesh (signed tetrahedra about the origin). */
export function volumeCentroid({ p, idx }, tris) {
  let vol = 0, cx = 0, cy = 0, cz = 0
  const list = tris ?? Array.from({ length: idx.length / 3 }, (_, i) => i)
  for (const t of list) {
    const a = idx[3*t], b = idx[3*t+1], c = idx[3*t+2]
    const ax = p[3*a], ay = p[3*a+1], az = p[3*a+2], bx = p[3*b], by = p[3*b+1], bz = p[3*b+2], cx_ = p[3*c], cy_ = p[3*c+1], cz_ = p[3*c+2]
    const v = (ax * (by * cz_ - bz * cy_) - ay * (bx * cz_ - bz * cx_) + az * (bx * cy_ - by * cx_)) / 6
    vol += v
    cx += v * (ax + bx + cx_) / 4; cy += v * (ay + by + cy_) / 4; cz += v * (az + bz + cz_) / 4
  }
  return { volume: vol, centroid: [cx / vol, cy / vol, cz / vol] }
}
