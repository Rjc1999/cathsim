// Which side branches of the LAD are septal perforators? Prints, for every LCA skeleton segment hanging off the LAD main path,
// the evidence: where it leaves the LAD (arc fraction t), its length, take-off angle, how posterior it runs, and how far it lies
// from the interventricular SEPTAL PLANE (best-fit plane through the LAD and PDA centerlines: the anterior and posterior
// interventricular grooves bound the septum). Septals run in that plane, diagonals leave it.
//   node scripts/septal-audit.mjs "<fbx>"        (needs public/models/heart.index.json from a previous build:heart)
import { readFileSync } from 'node:fs'
import { loadFbx, weldedMesh, components, sampleSurface, pointGraph, dijkstra, levelSetSkeleton, pruneSkeleton, buildSegments } from './lib/mesh.mjs'
import { makeTransform, volumeCentroid, MODEL_TO_MM } from './lib/transform.mjs'

const root = loadFbx(process.argv[2])
const by = Object.fromEntries(root.children.filter((c) => c.isMesh).map((m) => [m.name, m]))
const hb = weldedMesh(by.Hart_basis)
const T = makeTransform(volumeCentroid(hb, components(hb)[0].tris).centroid)
const art = weldedMesh(by.Arteries2)
const aorta = weldedMesh(by.Aorta)
const idx = JSON.parse(readFileSync('public/models/heart.index.json', 'utf8'))
const lad = idx.branches.find((b) => b.id === 'LAD').centerline.map((p) => p.slice(0, 3))
const pda = idx.branches.find((b) => b.id === 'PDA').centerline.map((p) => p.slice(0, 3))

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => {
  const l = Math.hypot(...a) || 1
  return a.map((v) => v / l)
}

// septal plane: PCA of LAD + PDA points, normal = smallest-variance axis (power iteration on the inverse is overkill: deflate twice)
const pts = [...lad, ...pda]
const c = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / pts.length)
const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
for (const p of pts) {
  const d = sub(p, c)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]
}
const mul = (v) => [0, 1, 2].map((i) => C[i][0] * v[0] + C[i][1] * v[1] + C[i][2] * v[2])
const power = (v, defl = []) => {
  for (let k = 0; k < 300; k++) {
    v = norm(mul(v))
    for (const d of defl) {
      const x = dot(v, d)
      v = norm(v.map((q, i) => q - x * d[i]))
    }
  }
  return v
}
const e1 = power([1, 0.3, 0.2])
const e2 = power([0.2, 1, 0.3], [e1])
const n = norm([e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]])
const planeDist = (p) => Math.abs(dot(sub(p, c), n))
console.log(`septal plane normal [${n.map((v) => v.toFixed(2))}] (LAD mean plane dist ${(lad.reduce((s, p) => s + planeDist(p), 0) / lad.length).toFixed(1)} mm, PDA ${(pda.reduce((s, p) => s + planeDist(p), 0) / pda.length).toFixed(1)} mm)`)

const comp = components(art).sort((a, b) => b.verts.length - a.verts.length)[0] // the bigger component is the LCA
const S = sampleSurface(art, comp.tris, 0.5, 7)
const nS = S.pts.length / 3
const adj = pointGraph(S.pts, 1.4)
let best = -1
let bd = Infinity
for (let i = 0; i < nS; i++) for (let a = 0; a < aorta.p.length; a += 9) {
  const d = (S.pts[3 * i] - aorta.p[a]) ** 2 + (S.pts[3 * i + 1] - aorta.p[a + 1]) ** 2 + (S.pts[3 * i + 2] - aorta.p[a + 2]) ** 2
  if (d < bd) { bd = d; best = i }
}
const dist = dijkstra(adj, best)
const sk = levelSetSkeleton({ p: S.pts }, adj, dist, Array.from({ length: nS }, (_, i) => i), 2.5)
const { keep } = pruneSkeleton(sk.nodes, 8)
const { segs } = buildSegments(sk.nodes, keep)
const lps = (i) => T.point(...sk.nodes[i].c)

// LAD main path = the segment chain the curated LAD centerline follows (seg1 ... apex): mark segments within 1.5 mm of it
const onLad = (p) => lad.some((q) => Math.hypot(...sub(p, q)) < 2.2)
const ladSegs = new Set(segs.filter((s) => s.nodes.length && s.nodes.filter((n2) => onLad(lps(n2))).length >= 0.7 * s.nodes.length).map((s) => s.id))
const ladLen = lad.reduce((s, p, i) => (i ? s + Math.hypot(...sub(p, lad[i - 1])) : 0), 0)
const arcAt = (p) => {
  let bestI = 0
  let bestD = Infinity
  lad.forEach((q, i) => { const d = Math.hypot(...sub(p, q)); if (d < bestD) { bestD = d; bestI = i } })
  let a = 0
  for (let i = 1; i <= bestI; i++) a += Math.hypot(...sub(lad[i], lad[i - 1]))
  return a / ladLen
}
console.log('\nLAD main-path segments:', [...ladSegs].sort((a, b) => a - b).join(' '))
console.log('\nside segments whose parent is on the LAD path (candidate septals):')
console.log('seg  parent  t_on_LAD  len(mm)  subtree  posterior(dy)  plane-dist(mm, mean/max)  takeoff-angle  end LPS')
for (const s of segs) {
  if (ladSegs.has(s.id) || s.parent < 0 || !ladSegs.has(s.parent)) continue
  const ps = s.nodes.map(lps)
  const a = ps[0]
  const b = ps[ps.length - 1]
  const dir = norm(sub(b, a))
  const par = segs[s.parent]
  const pp = par.nodes.map(lps)
  const pdir = norm(sub(pp[pp.length - 1], pp[Math.max(0, pp.length - 4)]))
  const ang = (Math.acos(Math.max(-1, Math.min(1, dot(dir, pdir)))) * 180) / Math.PI
  // include the whole subtree for the plane test
  const sub2 = []
  const walk = (id) => { segs[id].nodes.forEach((q) => sub2.push(lps(q))); segs[id].children.forEach(walk) }
  walk(s.id)
  const pd = sub2.map(planeDist)
  console.log(
    `${String(s.id).padStart(3)}  ${String(s.parent).padStart(5)}  ${arcAt(a).toFixed(2).padStart(8)}  ${(s.length * MODEL_TO_MM).toFixed(0).padStart(7)}  ${(s.subtreeLength * MODEL_TO_MM).toFixed(0).padStart(7)}  ${dir[1].toFixed(2).padStart(13)}  ${(pd.reduce((x, y) => x + y, 0) / pd.length).toFixed(1).padStart(10)} /${Math.max(...pd).toFixed(1).padStart(5)}  ${ang.toFixed(0).padStart(11)}  [${b.map((v) => v.toFixed(0))}]`,
  )
}
