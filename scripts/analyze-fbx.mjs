// Quantitative audit of the FBX: welded topology, connected components, watertightness, volume/area, radius estimate.
import { readFileSync } from 'node:fs'
import { BufferGeometry, Float32BufferAttribute, Texture, TextureLoader } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

globalThis.window ??= { innerWidth: 1, innerHeight: 1 }
TextureLoader.prototype.load = () => new Texture()
const buf = readFileSync(process.argv[2])
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
root.updateMatrixWorld(true)

function weld(mesh) {
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  const pos = g.getAttribute('position')
  const bare = new BufferGeometry()
  bare.setAttribute('position', new Float32BufferAttribute(Array.from(pos.array), 3))
  const w = mergeVertices(bare, 1e-3)
  return { p: w.getAttribute('position').array, idx: w.getIndex().array }
}
function stats({ p, idx }) {
  const nv = p.length / 3, nt = idx.length / 3
  // components (union-find) and boundary edges
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const edges = new Map()
  let vol = 0, area = 0
  for (let t = 0; t < nt; t++) {
    const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      parent[find(u)] = find(v)
      const k = u < v ? u * nv + v : v * nv + u
      edges.set(k, (edges.get(k) || 0) + 1)
    }
    const A = [p[3*a], p[3*a+1], p[3*a+2]], B = [p[3*b], p[3*b+1], p[3*b+2]], C = [p[3*c], p[3*c+1], p[3*c+2]]
    const cr = [(B[1]-A[1])*(C[2]-A[2])-(B[2]-A[2])*(C[1]-A[1]), (B[2]-A[2])*(C[0]-A[0])-(B[0]-A[0])*(C[2]-A[2]), (B[0]-A[0])*(C[1]-A[1])-(B[1]-A[1])*(C[0]-A[0])]
    area += Math.hypot(...cr) / 2
    vol += (A[0]*cr[0] + A[1]*cr[1] + A[2]*cr[2]) / 6
  }
  let boundary = 0, nonManifold = 0
  for (const c of edges.values()) { if (c === 1) boundary++; else if (c > 2) nonManifold++ }
  const comps = new Map()
  for (let i = 0; i < nv; i++) { const r = find(i); let c = comps.get(r); if (!c) comps.set(r, (c = { n: 0, min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9], sum: [0,0,0] })); c.n++; for (let k = 0; k < 3; k++) { const v = p[3*i+k]; c.min[k] = Math.min(c.min[k], v); c.max[k] = Math.max(c.max[k], v); c.sum[k] += v } }
  return { nv, nt, vol, area, boundary, nonManifold, comps: [...comps.values()].sort((a, b) => b.n - a.n) }
}
for (const m of root.children.filter((c) => c.isMesh)) {
  const s = stats(weld(m))
  const edgeLen = (s.area * 2 / s.nt) ** 0.5 * 1.1
  console.log(`\n${m.name}: welded verts ${s.nv}, tris ${s.nt}, boundary edges ${s.boundary}, non-manifold edges ${s.nonManifold}, components ${s.comps.length}`)
  console.log(`   volume ${s.vol.toFixed(0)}  area ${s.area.toFixed(0)}  mean edge ~${edgeLen.toFixed(2)}  tube-radius estimate 2V/A = ${(2 * Math.abs(s.vol) / s.area).toFixed(2)}`)
  for (const c of s.comps.slice(0, 6)) console.log(`   comp n=${c.n} bbox min ${c.min.map((v) => v.toFixed(0))} max ${c.max.map((v) => v.toFixed(0))} centroid ${c.sum.map((v) => (v / c.n).toFixed(0))}`)
}
