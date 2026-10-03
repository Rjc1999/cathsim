import { loadFbx, weldedMesh, components, sampleSurface, pointGraph, dijkstra, levelSetSkeleton, pruneSkeleton, buildSegments } from './lib/mesh.mjs'
import { makeTransform, volumeCentroid, MODEL_TO_MM } from './lib/transform.mjs'
const root = loadFbx(process.argv[2])
const by = Object.fromEntries(root.children.filter((c) => c.isMesh).map((m) => [m.name, m]))
const heart = weldedMesh(by.Hart_basis)
const hc = components(heart)[0]
const { volume, centroid } = volumeCentroid(heart, hc.tris)
console.log('Hart_basis volume', volume.toFixed(0), 'units³ →', (volume * MODEL_TO_MM ** 3 / 1000).toFixed(0), 'mL at scale', MODEL_TO_MM, '| centroid (model)', centroid.map((v) => v.toFixed(1)))
const T = makeTransform(centroid)
const art = weldedMesh(by.Arteries2), aorta = weldedMesh(by.Aorta)
const f = (a) => a.map((v) => v.toFixed(0)).join(',')
for (const [ci, comp] of components(art).entries()) {
  const S = sampleSurface(art, comp.tris, 0.5, 7)
  const n = S.pts.length / 3
  const adj = pointGraph(S.pts, 1.4)
  let best = -1, bd = Infinity
  for (let i = 0; i < n; i++) for (let a = 0; a < aorta.p.length; a += 9) { const d = (S.pts[3*i]-aorta.p[a])**2 + (S.pts[3*i+1]-aorta.p[a+1])**2 + (S.pts[3*i+2]-aorta.p[a+2])**2; if (d < bd) { bd = d; best = i } }
  const dist = dijkstra(adj, best)
  const all = Array.from({ length: n }, (_, i) => i)
  const sk = levelSetSkeleton({ p: S.pts }, adj, dist, all, 2.5)
  const { keep } = pruneSkeleton(sk.nodes, 8)
  const { segs } = buildSegments(sk.nodes, keep)
  const root0 = sk.nodes[segs[0].nodes[0]]
  console.log(`\n=== component ${ci} (${ci === 0 ? 'bigger' : 'smaller'}): root at LPS mm [${f(T.point(...root0.c))}], root radius ${(root0.r * MODEL_TO_MM).toFixed(1)} mm ===`)
  const show = (sid, depth) => {
    const s = segs[sid]
    const a = sk.nodes[s.nodes[0]], b = sk.nodes[s.nodes[s.nodes.length - 1]]
    const rMid = sk.nodes[s.nodes[Math.floor(s.nodes.length / 2)]].r * MODEL_TO_MM
    console.log(`${'  '.repeat(depth)}seg${sid} len ${(s.length * MODEL_TO_MM).toFixed(0)}mm subtree ${(s.subtreeLength * MODEL_TO_MM).toFixed(0)}mm  r~${rMid.toFixed(1)}  start [${f(T.point(...a.c))}] end [${f(T.point(...b.c))}]`)
    s.children.forEach((c) => show(c, depth + 1))
  }
  show(0, 0)
}
