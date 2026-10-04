// Cardiac venous system of the curated heart → public/models/<stem>.veins.glb + <stem>.veins.index.json
//   node scripts/build-veins.mjs "<file.fbx>" [out.glb]        (npm run build:veins)
// Kept separate from build-heart.mjs on purpose: the venous overlay is Explore-only and lazy-loaded, so the base heart.glb that every
// session downloads is untouched. Same frame as the arteries: patient LPS mm, isocenter = Hart_basis volume centroid.
//
// The source "Veins" mesh is one connected tree. It is skeletonised exactly like the arteries (surface samples → geodesic level-set
// skeleton → segments), ROOTED AT THE CORONARY SINUS OSTIUM so the CS is the trunk and every tributary hangs off it. Curated labels are
// pinned to skeleton segment ids (the skeleton is deterministic, seeded sampling), so a mismatch means the pipeline or the source changed.
// Segments that belong to no wanted vein (right-sided small cardiac / right ventricular veins) are labelled `drop` and not emitted:
// only the six structures below ship, which keeps the asset small.
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer'
import { buildSegments, components, dijkstra, levelSetSkeleton, loadFbx, pointGraph, pruneSkeleton, sampleSurface, weldedMesh } from './lib/mesh.mjs'
import { transformMesh, vertexNormals } from './lib/geom.mjs'
import { MODEL_TO_MM, makeTransform, volumeCentroid } from './lib/transform.mjs'

const [FBX, OUT = 'public/models/heart.veins.glb'] = process.argv.slice(2)
await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready])
const log = (...a) => console.log(...a)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
/** Model (x, y, z) → LPS (x, -z, y), for directions (no scale / translation). */
const dirToLps = (a) => [a[0], -a[2], a[1]]

// ---------------------------------------------------------------------------------------------- curated vein definitions
/** CS ostium: the open mouth of the coronary sinus in the right atrium (LPS mm). The skeleton is rooted here. */
const OSTIUM = [-28, 26, -6.5]
/** Skeleton nodes within this distance (mm) of the ostium point form the "CS Os" branch (the flared mouth). */
const OSTIUM_ZONE_MM = 9

/**
 * Anchors are LPS-mm points on the audited skeleton; `expectSeg` pins the segment id. Descendants inherit the label of their nearest named
 * ancestor, so the tributaries ride with their trunk (e.g. the left marginal vein with the GCV).
 *  - CS      coronary sinus body, ostium → junction with the GCV / PVLV (seg 0 + 27, ~55 mm)
 *  - MCV     middle cardiac vein: leaves the CS next to the ostium and runs in the posterior interventricular groove to the apex
 *  - GCV     great cardiac vein: left atrioventricular groove, from the CS to the anterior interventricular groove (seg 28 + 29)
 *  - AIV     anterior interventricular vein: runs beside the LAD down the anterior groove (the GCV's origin, with the apical tributaries)
 *  - PVLV    posterior vein of the left ventricle: enters the CS where the GCV begins and drains the posterior-inferior LV wall
 * `drop` segments are named only so their subtrees are not inherited by a neighbour.
 */
const VEINS = [
  { id: 'CS', label: 'Coronary sinus', expectSeg: 0, anchor: [-29, 27, -13], labelT: 0.75 },
  { id: 'MCV', label: 'Middle cardiac vein', expectSeg: 1, anchor: [-28, 25, -26], labelT: 0.45 },
  { id: 'GCV', label: 'Great cardiac vein', expectSeg: 28, anchor: [18, 61, 4], tipSeg: 29, labelT: 0.5 },
  { id: 'AIV', label: 'Anterior interventricular vein', expectSeg: 30, anchor: [26, -32, 31], labelT: 0.5 },
  { id: 'PVLV', label: 'Posterior vein of the left ventricle', expectSeg: 45, anchor: [7, 57, -20], labelT: 0.5 },
  { id: 'drop-right', drop: true, expectSeg: 2, anchor: [-48, -1, -35] }, // small cardiac vein and the right ventricular veins
  { id: 'drop-stub', drop: true, expectSeg: 26, anchor: [-22, 27, -35] },
]
const ANCHOR_TOLERANCE_MM = 4
const OSTIUM_ID = 'CS Os'
const OSTIUM_LABEL = 'Coronary sinus ostium'

// ---------------------------------------------------------------------------------------------- 1. load, transform, skeleton
const root = loadFbx(FBX)
const by = Object.fromEntries(root.children.filter((c) => c.isMesh).map((m) => [m.name, m]))
const heartRaw = weldedMesh(by.Hart_basis)
const T = makeTransform(volumeCentroid(heartRaw, components(heartRaw)[0].tris).centroid)
const vm = weldedMesh(by.Veins)
const comps = components(vm)
if (comps.length !== 1) throw new Error(`expected 1 venous component, found ${comps.length}`)
const comp = comps[0]
const vLps = transformMesh(vm, T.point)
const vNormals = vertexNormals(vLps) // whole-tree smooth normals, so split branches share seam normals

const S = sampleSurface(vm, comp.tris, 0.5, 7)
const nS = S.pts.length / 3
const adj = pointGraph(S.pts, 1.4)
let rootSample = -1
let bd = Infinity
for (let i = 0; i < nS; i++) {
  const q = T.point(S.pts[3 * i], S.pts[3 * i + 1], S.pts[3 * i + 2])
  const d = Math.hypot(...sub(q, OSTIUM))
  if (d < bd) {
    bd = d
    rootSample = i
  }
}
if (bd > 2) throw new Error(`no venous surface within 2 mm of the CS ostium point (nearest ${bd.toFixed(1)} mm)`)
const dist = dijkstra(adj, rootSample)
const sk = levelSetSkeleton({ p: S.pts }, adj, dist, Array.from({ length: nS }, (_, i) => i), 2.5)
const { keep } = pruneSkeleton(sk.nodes, 4)
const { segs, segOf } = buildSegments(sk.nodes, keep)
const nodes = sk.nodes
const lps = (i) => T.point(...nodes[i].c)

const nearestSeg = (anchor) => {
  let bestSeg = -1
  let bestD = Infinity
  for (const s of segs) {
    for (const n of s.nodes) {
      const d = Math.hypot(...sub(lps(n), anchor))
      if (d < bestD) {
        bestD = d
        bestSeg = s.id
      }
    }
  }
  return { seg: bestSeg, dist: bestD }
}
const defs = VEINS.map((b) => {
  const r = nearestSeg(b.anchor)
  if (r.dist > ANCHOR_TOLERANCE_MM) throw new Error(`${b.id}: anchor is ${r.dist.toFixed(1)} mm from the skeleton (limit ${ANCHOR_TOLERANCE_MM})`)
  if (r.seg !== b.expectSeg) throw new Error(`${b.id}: anchor resolved to seg${r.seg}, expected seg${b.expectSeg}`)
  return { ...b, seg: r.seg, anchorDist: r.dist }
})
const bySeg = new Map(defs.map((d) => [d.seg, d]))
if (bySeg.get(0)?.id !== 'CS') throw new Error('the skeleton root segment must be the coronary sinus')

// Every segment inherits the label of its nearest named ancestor.
const labelOfSeg = new Array(segs.length)
for (const s of segs) {
  const named = bySeg.get(s.id)
  labelOfSeg[s.id] = named ? named.id : labelOfSeg[s.parent]
}
const inOstium = (n) => Math.hypot(...sub(lps(n), OSTIUM)) <= OSTIUM_ZONE_MM
const labelOfNode = (n) => (inOstium(n) ? OSTIUM_ID : labelOfSeg[segOf[n]])

const keptAnc = (i) => {
  while (!keep[i] && nodes[i].parent >= 0) i = nodes[i].parent
  return i
}
const heavyChild = (i) => {
  let b = -1
  let bl = -1
  for (const c of nodes[i].children) {
    if (!keep[c]) continue
    const l = segs[segOf[c]].subtreeLength
    if (l > bl) {
      bl = l
      b = c
    }
  }
  return b
}
const axisAt = (i) => {
  let a = i
  let b = i
  for (let k = 0; k < 3 && nodes[a].parent >= 0 && keep[nodes[a].parent]; k++) a = nodes[a].parent
  for (let k = 0; k < 3; k++) {
    const c = heavyChild(b)
    if (c < 0) break
    b = c
  }
  return norm(sub(nodes[b].c, nodes[a].c))
}

// spatial hash of the surface samples (vertex → skeleton node)
const cell = 1.0
const grid = new Map()
const gkey = (cx, cy, cz) => `${cx},${cy},${cz}`
for (let i = 0; i < nS; i++) {
  const k = gkey(Math.floor(S.pts[3 * i] / cell), Math.floor(S.pts[3 * i + 1] / cell), Math.floor(S.pts[3 * i + 2] / cell))
  if (!grid.has(k)) grid.set(k, [])
  grid.get(k).push(i)
}
const nearestSample = (x, y, z) => {
  for (let rad = 1; rad <= 4; rad++) {
    let bi = -1
    let bdd = Infinity
    const cx = Math.floor(x / cell)
    const cy = Math.floor(y / cell)
    const cz = Math.floor(z / cell)
    for (let dx = -rad; dx <= rad; dx++)
      for (let dy = -rad; dy <= rad; dy++)
        for (let dz = -rad; dz <= rad; dz++)
          for (const i of grid.get(gkey(cx + dx, cy + dy, cz + dz)) ?? []) {
            const d = (S.pts[3 * i] - x) ** 2 + (S.pts[3 * i + 1] - y) ** 2 + (S.pts[3 * i + 2] - z) ** 2
            if (d < bdd) {
              bdd = d
              bi = i
            }
          }
    if (bi >= 0) return bi
  }
  return 0
}

// per-vertex label, local lumen radius (distance to the local axis; the CS is wider than any artery, hence the 12-unit cap) and axis (LPS)
const vLabel = new Map()
const vRad = new Map()
const vAxis = new Map()
for (const v of comp.verts) {
  const x = vm.p[3 * v]
  const y = vm.p[3 * v + 1]
  const z = vm.p[3 * v + 2]
  const node = keptAnc(sk.nodeOf[nearestSample(x, y, z)])
  const a = axisAt(node)
  const c = nodes[node].c
  const d = [x - c[0], y - c[1], z - c[2]]
  const along = dot(d, a)
  const r = Math.hypot(d[0] - along * a[0], d[1] - along * a[1], d[2] - along * a[2])
  vLabel.set(v, labelOfNode(node))
  vRad.set(v, Math.min(Math.max(r, 0.5), 12) * MODEL_TO_MM)
  vAxis.set(v, norm(dirToLps(a)))
}

// ---------------------------------------------------------------------------------------------- 2. centerlines
const emitted = [...defs.filter((d) => !d.drop), { id: OSTIUM_ID, label: OSTIUM_LABEL, labelT: 0.5, ostium: true }]
const median = (arr, i, w) => {
  const win = arr.slice(Math.max(0, i - w), i + w + 1).sort((a, b) => a - b)
  return win[Math.floor(win.length / 2)]
}
const qa = []
for (const def of emitted) {
  let pathNodes
  if (def.ostium) {
    // the nodes of the mouth, from the opening inwards
    pathNodes = nodes.map((_, i) => i).filter((n) => keep[n] && inOstium(n)).sort((a, b) => nodes[a].bin - nodes[b].bin)
  } else {
    const pathSegs = []
    if (def.tipSeg !== undefined) {
      for (let s = def.tipSeg; s >= 0 && s !== def.seg; s = segs[s].parent) pathSegs.unshift(s)
      pathSegs.unshift(def.seg)
    } else {
      let s = def.seg
      for (;;) {
        pathSegs.push(s)
        const next = segs[s].children.filter((c) => labelOfSeg[c] === def.id).sort((a, b) => segs[b].subtreeLength - segs[a].subtreeLength)[0]
        if (next === undefined) break
        s = next
      }
    }
    pathNodes = pathSegs.flatMap((s) => segs[s].nodes).filter((n) => labelOfNode(n) === def.id)
  }
  if (pathNodes.length < 2) throw new Error(`${def.id}: centerline has ${pathNodes.length} nodes`)
  let pts = pathNodes.map((n) => lps(n))
  let rs = pathNodes.map((n) => nodes[n].r * MODEL_TO_MM)
  rs = rs.map((_, i) => median(rs, i, 4)) // junction nodes inflate the ring radius; the median removes the spikes
  const smoothAt = (i, w) => {
    let s = [0, 0, 0]
    let n = 0
    for (let k = Math.max(0, i - w); k <= Math.min(pts.length - 1, i + w); k++) {
      s = [s[0] + pts[k][0], s[1] + pts[k][1], s[2] + pts[k][2]]
      n++
    }
    return [s[0] / n, s[1] / n, s[2] / n]
  }
  pts = pts.map((_, i) => (i === 0 || i === pts.length - 1 ? pts[i] : smoothAt(i, 2)))
  const out = [[...pts[0], rs[0]]]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(...sub(pts[i], pts[i - 1]))
    if (acc >= 2 || i === pts.length - 1) {
      out.push([...pts[i], rs[i]])
      acc = 0
    }
  }
  let length = 0
  for (let i = 1; i < out.length; i++) length += Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1], out[i][2] - out[i - 1][2])
  def.centerline = out.map((p) => p.map((v) => +v.toFixed(2)))
  def.length = length
  def.hit = nodes
    .map((_, i) => i)
    .filter((n) => keep[n] && labelOfNode(n) === def.id)
    .filter((_, i) => i % 2 === 0)
    .map((n) => lps(n).map((v) => +v.toFixed(1)))
  qa.push(`${def.id}: centerline ${out.length} pts ${length.toFixed(0)} mm, mean r ${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)} mm, hit pts ${def.hit.length}, from [${out[0].slice(0, 3).map((v) => v.toFixed(0))}] to [${out[out.length - 1].slice(0, 3).map((v) => v.toFixed(0))}]`)
}

// ---------------------------------------------------------------------------------------------- 3. split the surface by label
const branchMeshes = []
for (const def of emitted) {
  const tris = []
  for (const t of comp.tris) {
    const a = vm.idx[3 * t]
    const b = vm.idx[3 * t + 1]
    const c = vm.idx[3 * t + 2]
    const la = vLabel.get(a)
    const lb = vLabel.get(b)
    const lc = vLabel.get(c)
    const L = la === lb || la === lc ? la : lb === lc ? lb : la
    if (L === def.id) tris.push(a, b, c)
  }
  if (!tris.length) throw new Error(`no triangles for ${def.id}`)
  const remap = new Map()
  const p = []
  const n = []
  const r = []
  const ax = []
  const idx = []
  for (const v of tris) {
    let i = remap.get(v)
    if (i === undefined) {
      i = p.length / 3
      remap.set(v, i)
      p.push(vLps.p[3 * v], vLps.p[3 * v + 1], vLps.p[3 * v + 2])
      n.push(vNormals[3 * v], vNormals[3 * v + 1], vNormals[3 * v + 2])
      r.push(vRad.get(v))
      ax.push(...vAxis.get(v))
    }
    idx.push(i)
  }
  branchMeshes.push({ def, p: Float32Array.from(p), n: Float32Array.from(n), r: Float32Array.from(r), ax: Float32Array.from(ax), idx: Uint32Array.from(idx) })
}
log('--- cardiac veins ---')
qa.forEach((l) => log(l))
for (const b of branchMeshes) log(`  VEN_${b.def.id}: ${b.idx.length / 3} tris, ${b.p.length / 3} verts`)
log(`total ${branchMeshes.reduce((s, b) => s + b.idx.length / 3, 0)} tris of ${comp.tris.length} in the source (right-sided / small veins dropped)`)

// ---------------------------------------------------------------------------------------------- 4. write GLB + index
const doc = new Document()
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
const buffer = doc.createBuffer()
const scene = doc.createScene('CathSimVeins').setExtras({
  coordinateSystem: 'LPS mm: +X patient left, +Y posterior, +Z cranial; isocenter at origin (same frame as heart.glb)',
  source: 'anatomical-heart-codominance (FBX, rechts dominant versie 1), mesh "Veins"',
})
doc.getRoot().setDefaultScene(scene)
const accessor = (data, type) => doc.createAccessor().setArray(data).setType(type).setBuffer(buffer)
/** Unit vectors as normalised int8 (precision 1/127, about 0.45 degrees): 12 → 4 bytes per vertex. */
const unitInt8 = (data, type) => doc.createAccessor().setArray(Int8Array.from(data, (v) => Math.round(v * 127))).setType(type).setNormalized(true).setBuffer(buffer)
for (const b of branchMeshes) {
  const prim = doc
    .createPrimitive()
    .setIndices(accessor(b.idx, 'SCALAR'))
    .setAttribute('POSITION', accessor(b.p, 'VEC3'))
    .setAttribute('NORMAL', unitInt8(b.n, 'VEC3'))
    .setAttribute('_RADIUS', accessor(b.r, 'SCALAR'))
    .setAttribute('_AXIS', unitInt8(b.ax, 'VEC3'))
  const name = `VEN_${b.def.id}`
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)).setExtras({ kind: 'venous', system: 'VEN', id: b.def.id, label: b.def.label }))
}
mkdirSync(dirname(OUT), { recursive: true })
const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
await io.write(OUT, doc)
const indexPath = OUT.replace(/\.glb$/, '.index.json')
writeFileSync(
  indexPath,
  JSON.stringify({
    version: 1,
    coordinateSystem: 'LPS mm: +X patient left, +Y posterior, +Z cranial; isocenter at origin',
    source: 'anatomical-heart-codominance (rechts dominant versie 1.fbx), mesh "Veins"',
    ostium: OSTIUM,
    branches: branchMeshes.map((b) => ({
      system: 'VEN',
      id: b.def.id,
      label: b.def.label,
      labelT: b.def.labelT,
      lengthMm: +b.def.length.toFixed(1),
      /** [x, y, z, lumen radius] roughly every 2 mm along the main path, origin → distal (LPS mm). */
      centerline: b.def.centerline,
      /** every skeleton point of the branch group, for tap hit-testing. */
      hit: b.def.hit,
    })),
  }),
)
log(`\nwrote ${OUT}: ${(statSync(OUT).size / 1024).toFixed(0)} KB, ${indexPath}: ${(statSync(indexPath).size / 1024).toFixed(0)} KB`)
