// Prints a real on-skeleton LPS point (segment middle node) for the audited segment ids, to use as curated anchors.
import { loadFbx, weldedMesh, components, sampleSurface, pointGraph, dijkstra, levelSetSkeleton, pruneSkeleton, buildSegments } from './lib/mesh.mjs'
import { makeTransform, volumeCentroid } from './lib/transform.mjs'
const root = loadFbx(process.argv[2])
const by = Object.fromEntries(root.children.filter((c) => c.isMesh).map((m) => [m.name, m]))
const hb = weldedMesh(by.Hart_basis)
const T = makeTransform(volumeCentroid(hb, components(hb)[0].tris).centroid)
const art = weldedMesh(by.Arteries2), aorta = weldedMesh(by.Aorta)
const want = { 0: [0, 1, 24, 5, 26, 36, 28, 23, 20, 18], 1: [0, 18, 7, 4, 3] }
const comps = components(art)
for (const [ci, comp] of comps.entries()) {
  const S = sampleSurface(art, comp.tris, 0.5, 7)
  const n = S.pts.length / 3, adj = pointGraph(S.pts, 1.4)
  let best = -1, bd = Infinity
  for (let i = 0; i < n; i++) for (let a = 0; a < aorta.p.length; a += 9) { const d = (S.pts[3*i]-aorta.p[a])**2 + (S.pts[3*i+1]-aorta.p[a+1])**2 + (S.pts[3*i+2]-aorta.p[a+2])**2; if (d < bd) { bd = d; best = i } }
  const dist = dijkstra(adj, best)
  const sk = levelSetSkeleton({ p: S.pts }, adj, dist, Array.from({ length: n }, (_, i) => i), 2.5)
  const { keep } = pruneSkeleton(sk.nodes, 8)
  const { segs } = buildSegments(sk.nodes, keep)
  for (const id of want[ci]) { const s = segs[id]; const mid = sk.nodes[s.nodes[Math.floor(s.nodes.length / 2)]]; console.log(`comp${ci} seg${id} (${s.nodes.length} nodes) mid LPS [${T.point(...mid.c).map((v) => v.toFixed(1))}]`) }
}
