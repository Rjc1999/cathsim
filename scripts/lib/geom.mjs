// Geometry utilities for the heart build: plane clipping, hole capping, simplification, normals. Meshes are { p: Float32Array, idx: Uint32Array }.
import { MeshoptSimplifier } from 'meshoptimizer'

/** Keep the half-space where n·x <= d. Triangles are split on the plane; intersection vertices are shared across edges. */
export function clipHalfSpace({ p, idx }, n, d) {
  const verts = Array.from(p)
  const out = []
  const cache = new Map()
  const sv = (i) => n[0] * p[3*i] + n[1] * p[3*i+1] + n[2] * p[3*i+2] - d
  const cut = (a, b) => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`
    let i = cache.get(k)
    if (i === undefined) {
      const sa = sv(a), sb = sv(b), t = sa / (sa - sb)
      i = verts.length / 3
      verts.push(p[3*a] + t * (p[3*b] - p[3*a]), p[3*a+1] + t * (p[3*b+1] - p[3*a+1]), p[3*a+2] + t * (p[3*b+2] - p[3*a+2]))
      cache.set(k, i)
    }
    return i
  }
  for (let t = 0; t < idx.length; t += 3) {
    const tri = [idx[t], idx[t+1], idx[t+2]]
    const s = tri.map(sv)
    const inside = s.map((v) => v <= 0)
    const n_in = inside.filter(Boolean).length
    if (n_in === 3) out.push(...tri)
    else if (n_in === 0) continue
    else {
      // walk the polygon, emitting kept vertices and edge intersections, then fan-triangulate (keeps orientation)
      const poly = []
      for (let k = 0; k < 3; k++) {
        const a = tri[k], b = tri[(k + 1) % 3]
        if (inside[k]) poly.push(a)
        if (inside[k] !== inside[(k + 1) % 3]) poly.push(cut(a, b))
      }
      for (let k = 1; k + 1 < poly.length; k++) out.push(poly[0], poly[k], poly[k + 1])
    }
  }
  return compact({ p: Float32Array.from(verts), idx: Uint32Array.from(out) })
}

/** Remove unreferenced vertices. */
export function compact({ p, idx }) {
  const remap = new Int32Array(p.length / 3).fill(-1)
  const np = []
  const ni = new Uint32Array(idx.length)
  for (let i = 0; i < idx.length; i++) {
    const v = idx[i]
    if (remap[v] < 0) { remap[v] = np.length / 3; np.push(p[3*v], p[3*v+1], p[3*v+2]) }
    ni[i] = remap[v]
  }
  return { p: Float32Array.from(np), idx: ni }
}

/** Close every boundary loop with a centroid fan oriented consistently with the surface. Returns { mesh, loops, skipped }. */
export function capHoles({ p, idx }) {
  const half = new Map() // directed edge u→v (as it appears in a triangle) → count; boundary = no opposite edge
  const key = (u, v) => u * 4294967296 + v
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) { const u = idx[t+k], v = idx[t+(k+1)%3]; half.set(key(u, v), (half.get(key(u, v)) || 0) + 1) }
  const next = new Map()
  for (const [k, c] of half) {
    const u = Math.floor(k / 4294967296), v = k % 4294967296
    if (c === 1 && !half.has(key(v, u))) { (next.get(u) ?? next.set(u, []).get(u)).push(v) }
  }
  const verts = Array.from(p), tris = Array.from(idx)
  let loops = 0, skipped = 0
  const used = new Set()
  for (const start of next.keys()) {
    if (used.has(start)) continue
    const loop = [start]; used.add(start)
    let cur = start, ok = true
    for (;;) {
      const options = (next.get(cur) || []).filter((v) => v === start || !used.has(v))
      if (!options.length) { ok = false; break }
      const nx = options.includes(start) && loop.length > 2 ? start : options[0]
      if (nx === start) break
      loop.push(nx); used.add(nx); cur = nx
    }
    if (!ok || loop.length < 3) { skipped++; continue }
    let cx = 0, cy = 0, cz = 0
    for (const v of loop) { cx += p[3*v]; cy += p[3*v+1]; cz += p[3*v+2] }
    const c = verts.length / 3
    verts.push(cx / loop.length, cy / loop.length, cz / loop.length)
    // surface has u→v along the boundary; the cap must run v→u to keep a consistent orientation
    for (let i = 0; i < loop.length; i++) tris.push(loop[(i + 1) % loop.length], loop[i], c)
    loops++
  }
  return { mesh: { p: Float32Array.from(verts), idx: Uint32Array.from(tris) }, loops, skipped }
}

export function simplify(mesh, targetTris, targetError = 0.01) {
  if (targetTris * 3 >= mesh.idx.length) return mesh // nothing to remove (the simplifier asserts target <= current)
  const [idx] = MeshoptSimplifier.simplify(mesh.idx, mesh.p, 3, targetTris * 3, targetError, ['LockBorder'])
  return compact({ p: mesh.p, idx })
}

export function vertexNormals({ p, idx }) {
  const n = new Float32Array(p.length)
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t+1], c = idx[t+2]
    const ux = p[3*b]-p[3*a], uy = p[3*b+1]-p[3*a+1], uz = p[3*b+2]-p[3*a+2]
    const vx = p[3*c]-p[3*a], vy = p[3*c+1]-p[3*a+1], vz = p[3*c+2]-p[3*a+2]
    const nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx // area-weighted
    for (const i of [a, b, c]) { n[3*i] += nx; n[3*i+1] += ny; n[3*i+2] += nz }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i], n[i+1], n[i+2]) || 1; n[i] /= l; n[i+1] /= l; n[i+2] /= l }
  return n
}

export function signedVolume({ p, idx }) {
  let v = 0
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t+1], c = idx[t+2]
    v += (p[3*a] * (p[3*b+1]*p[3*c+2] - p[3*b+2]*p[3*c+1]) - p[3*a+1] * (p[3*b]*p[3*c+2] - p[3*b+2]*p[3*c]) + p[3*a+2] * (p[3*b]*p[3*c+1] - p[3*b+1]*p[3*c])) / 6
  }
  return v
}

export function boundaryEdgeCount({ idx }) {
  const half = new Set()
  for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) half.add(idx[t+k] * 4294967296 + idx[t+(k+1)%3])
  let n = 0
  for (const e of half) { const u = Math.floor(e / 4294967296), v = e % 4294967296; if (!half.has(v * 4294967296 + u)) n++ }
  return n
}

export const transformMesh = (mesh, fn) => {
  const p = new Float32Array(mesh.p.length)
  for (let i = 0; i < mesh.p.length; i += 3) { const q = fn(mesh.p[i], mesh.p[i+1], mesh.p[i+2]); p[i] = q[0]; p[i+1] = q[1]; p[i+2] = q[2] }
  return { p, idx: mesh.idx }
}
