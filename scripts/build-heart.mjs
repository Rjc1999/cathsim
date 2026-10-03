// FBX → optimized, LPS-aligned GLB for CathSim.
//   node scripts/build-heart.mjs "<file.fbx>" [out.glb]
// Everything in the output is in patient LPS millimetres, isocenter = volumetric centroid of the myocardium.
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Document, NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression } from '@gltf-transform/extensions'
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer'
import { buildSegments, components, dijkstra, levelSetSkeleton, loadFbx, pointGraph, pruneSkeleton, sampleSurface, weldedMesh } from './lib/mesh.mjs'
import { boundaryEdgeCount, capHoles, clipHalfSpace, compact, signedVolume, simplify, transformMesh, vertexNormals } from './lib/geom.mjs'
import { MODEL_TO_MM, makeTransform, volumeCentroid } from './lib/transform.mjs'
import { buildEnvelope } from './lib/voxel.mjs'

const [FBX, OUT = 'public/models/heart.glb'] = process.argv.slice(2)
await Promise.all([MeshoptSimplifier.ready, MeshoptEncoder.ready, MeshoptDecoder.ready])
const log = (...a) => console.log(...a)
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a) => {
  const l = Math.hypot(...a) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
/** Model (x, y, z) → LPS (x, -z, y), for directions (no scale / translation). */
const dirToLps = (a) => [a[0], -a[2], a[1]]

// ---------------------------------------------------------------------------------------------- 1. load + transform
const root = loadFbx(FBX)
const by = Object.fromEntries(root.children.filter((c) => c.isMesh).map((m) => [m.name, m]))
const heartRaw = weldedMesh(by.Hart_basis)
const heartComp = components(heartRaw)[0]
const { centroid, volume } = volumeCentroid(heartRaw, heartComp.tris)
const T = makeTransform(centroid)
log(`isocenter = Hart_basis volume centroid (model units) ${centroid.map((v) => v.toFixed(1))}; volume ${((volume * MODEL_TO_MM ** 3) / 1000).toFixed(0)} mL at scale ${MODEL_TO_MM}`)

const submesh = (w, tris) =>
  compact({ p: w.p, idx: Uint32Array.from(Array.from(tris).flatMap((t) => [w.idx[3 * t], w.idx[3 * t + 1], w.idx[3 * t + 2]])) })
const largest = (name) => {
  const w = weldedMesh(by[name])
  return submesh(w, components(w)[0].tris)
}
const flip = (m) => {
  const idx = Uint32Array.from(m.idx)
  for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]]
  return { p: m.p, idx }
}
const prepSoft = (mesh, tris, clips = []) => {
  let m = transformMesh(mesh, T.point)
  for (const [n, d] of clips) m = clipHalfSpace(m, n, d)
  m = capHoles(m).mesh
  m = simplify(m, tris, 0.02)
  return signedVolume(m) < 0 ? flip(m) : m // closed meshes must wind outward for the thickness pass
}
const soft = {
  Myocardium: prepSoft(submesh(heartRaw, heartComp.tris), 22000),
  LeftAtrialAppendage: prepSoft(largest('Heartear'), 3500),
  // Ascending aorta only: keep z <= 95 mm (cranial) and y <= 40 mm (anterior); this drops the arch and the descending limb.
  Aorta: prepSoft(largest('Aorta'), 6000, [[[0, 0, 1], 95], [[0, 1, 0], 40]]),
  PulmonaryTrunk: prepSoft(largest('Pulmonary_trunk'), 5000),
}
for (const [k, m] of Object.entries(soft)) {
  log(`${k}: verts ${m.p.length / 3} tris ${m.idx.length / 3} volume ${(signedVolume(m) / 1000).toFixed(1)} mL boundary edges ${boundaryEdgeCount(m)}`)
}

// The source meshes are hollow (chambers and vessel lumens are empty surfaces inside the walls), so an X-ray shadow
// computed from them would measure wall thickness only. The soft-tissue shadow uses the FILLED union volume instead.
const envelopeResult = buildEnvelope(Object.values(soft), 1.25, 14)
let envelope = envelopeResult.mesh
if (signedVolume(envelope) < 0) envelope = flip(envelope)
envelope = simplify(envelope, 16000, 0.02)
log(`SoftTissueEnvelope: grid ${envelopeResult.stats.dims.join('x')} @ ${envelopeResult.stats.h} mm, solid ${(envelopeResult.stats.solidVoxels * envelopeResult.stats.h ** 3 / 1000).toFixed(0)} mL (incl. dilation); mesh verts ${envelope.p.length / 3} tris ${envelope.idx.length / 3} volume ${(signedVolume(envelope) / 1000).toFixed(0)} mL boundary edges ${boundaryEdgeCount(envelope)}`)

// ---------------------------------------------------------------------------------------------- 2. arteries
const art = weldedMesh(by.Arteries2)
const aortaFull = weldedMesh(by.Aorta)
const artLps = transformMesh(art, T.point)
const artNormalsLps = vertexNormals(artLps) // whole-tree smooth normals, so split branches share seam normals

/** Curated branch definitions: anchors are LPS-mm points picked on the audited skeleton (see run_log). */
const BRANCHES = {
  LCA: [
    { id: 'LM', label: 'Left main', expectSeg: 0, anchor: [7.9, -1.4, 44.9], exclusive: true, labelT: 0.5 },
    { id: 'LAD', label: 'Left anterior descending', expectSeg: 1, anchor: [13.6, -11.4, 41.3], labelT: 0.3 },
    { id: 'D1', label: 'First diagonal', expectSeg: 24, anchor: [45.9, -15, 32], labelT: 0.55 },
    { id: 'D2', label: 'Second diagonal', expectSeg: 5, anchor: [51.7, -45.6, -3.4], labelT: 0.55 },
    // Septal perforators of the LAD, chosen by scripts/septal-audit.mjs: they leave the LAD heading posteriorly (dy > +0.3) and stay
    // inside the interventricular septal plane (best fit through the LAD and PDA grooves; mean distance 1.2 / 2.9 / 3.1 mm, whereas
    // the diagonals D1 / D2 lie 28 / 11 mm from it). Numbered proximal to distal by where they leave the LAD (t = 0.27 / 0.50 / 0.64).
    // S3 leaves at only 26 degrees (S1 44, S2 49), so it is the least certain of the three. Shorter stubs (< 16 mm) stay with the LAD.
    { id: 'S1', label: 'First septal perforator', expectSeg: 23, anchor: [17.4, -26.8, -2.5], labelT: 0.5 },
    { id: 'S2', label: 'Second septal perforator', expectSeg: 20, anchor: [29.2, -42.9, -6.7], labelT: 0.5 },
    { id: 'S3', label: 'Third septal perforator', expectSeg: 18, anchor: [37.7, -48.0, -19.9], labelT: 0.55 },
    { id: 'LCx', label: 'Left circumflex', expectSeg: 26, anchor: [20.5, 35, 38.9], tip: [-1.1, 59.8, -4.8], labelT: 0.4 },
    { id: 'OM1', label: 'First obtuse marginal', expectSeg: 36, anchor: [37.4, 50.4, 7.2], labelT: 0.6 },
  ],
  RCA: [
    { id: 'RCA', label: 'Right coronary artery', expectSeg: 0, anchor: [-24.1, -39.6, 43.8], root: true, labelT: 0.35 },
    { id: 'AM', label: 'Acute marginal', expectSeg: 18, anchor: [-24.5, -30.7, -47.3], labelT: 0.5 },
    { id: 'PDA', label: 'Posterior descending artery', expectSeg: 7, anchor: [-22.5, 14.5, -39.8], labelT: 0.45 },
    { id: 'PLB', label: 'Posterolateral branch', expectSeg: 4, anchor: [-33.4, 16.8, -24.6], labelT: 0.6 },
  ],
}
const ANCHOR_TOLERANCE_MM = 4
// `expectSeg` pins each anchor to the segment id of the audited skeleton (scripts/skeleton-tips.mjs); the skeleton is
// deterministic (seeded sampling), so a mismatch means the pipeline parameters or the source model changed.

const comps = components(art)
if (comps.length !== 2) throw new Error(`expected 2 coronary components, found ${comps.length}`)
const meanX = (c) => c.verts.reduce((s, v) => s + art.p[3 * v], 0) / c.verts.length
// the component further towards patient-left (+X) is the LCA
const systems = meanX(comps[0]) > meanX(comps[1]) ? ['LCA', 'RCA'] : ['RCA', 'LCA']

const branchMeshes = []
const qa = []
const avGroovePoints = []

for (const [ci, comp] of comps.entries()) {
  const system = systems[ci]
  const S = sampleSurface(art, comp.tris, 0.5, 7)
  const nS = S.pts.length / 3
  const adj = pointGraph(S.pts, 1.4)
  let best = -1
  let bd = Infinity // ostium = sample nearest the aortic root surface
  for (let i = 0; i < nS; i++) {
    for (let a = 0; a < aortaFull.p.length; a += 9) {
      const d = (S.pts[3 * i] - aortaFull.p[a]) ** 2 + (S.pts[3 * i + 1] - aortaFull.p[a + 1]) ** 2 + (S.pts[3 * i + 2] - aortaFull.p[a + 2]) ** 2
      if (d < bd) {
        bd = d
        best = i
      }
    }
  }
  const dist = dijkstra(adj, best)
  const sk = levelSetSkeleton({ p: S.pts }, adj, dist, Array.from({ length: nS }, (_, i) => i), 2.5)
  const { keep } = pruneSkeleton(sk.nodes, 8)
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
  const defs = BRANCHES[system].map((b) => {
    const r = nearestSeg(b.anchor)
    if (r.dist > ANCHOR_TOLERANCE_MM) throw new Error(`${system}/${b.id}: anchor is ${r.dist.toFixed(1)} mm from the skeleton (limit ${ANCHOR_TOLERANCE_MM})`)
    if (b.expectSeg !== undefined && r.seg !== b.expectSeg) throw new Error(`${system}/${b.id}: anchor resolved to seg${r.seg}, expected seg${b.expectSeg}`)
    return { ...b, seg: r.seg, anchorDist: r.dist, tipSeg: b.tip ? nearestSeg(b.tip).seg : null }
  })
  const bySeg = new Map(defs.map((d) => [d.seg, d]))
  const rootSeg = 0
  const fallback = (defs.find((d) => d.root) ?? defs.find((d) => !d.exclusive)).id
  // Every segment inherits the label of its nearest named ancestor (unnamed twigs and septals join their parent branch).
  const labelOfSeg = new Array(segs.length)
  for (const s of segs) {
    const named = bySeg.get(s.id)
    if (named) labelOfSeg[s.id] = named.id
    else if (s.parent < 0) labelOfSeg[s.id] = fallback
    else {
      const parentDef = bySeg.get(s.parent)
      // exclusive branches (LM) do not donate their label to unnamed children
      labelOfSeg[s.id] = parentDef?.exclusive ? fallback : labelOfSeg[s.parent]
    }
  }
  if (!bySeg.has(rootSeg) && system === 'LCA') throw new Error('LCA root segment is not labelled LM; check the LM anchor')

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

  // per-vertex label, local lumen radius (distance to the local axis) and axis direction (LPS)
  const vLabel = new Map()
  const vRad = new Map()
  const vAxis = new Map()
  for (const v of comp.verts) {
    const x = art.p[3 * v]
    const y = art.p[3 * v + 1]
    const z = art.p[3 * v + 2]
    const node = keptAnc(sk.nodeOf[nearestSample(x, y, z)])
    const a = axisAt(node)
    const c = nodes[node].c
    const d = [x - c[0], y - c[1], z - c[2]]
    const along = dot(d, a)
    const r = Math.hypot(d[0] - along * a[0], d[1] - along * a[1], d[2] - along * a[2])
    vLabel.set(v, labelOfSeg[segOf[node]])
    vRad.set(v, Math.min(Math.max(r, 0.5), 8) * MODEL_TO_MM)
    vAxis.set(v, norm(dirToLps(a)))
  }

  // centerline per named branch (path to the tip anchor if given, else the heaviest same-label child chain)
  const labelNodes = (id) => segs.filter((s) => labelOfSeg[s.id] === id).flatMap((s) => s.nodes)
  for (const def of defs) {
    const pathSegs = []
    if (def.tipSeg !== null) {
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
    const pathNodes = pathSegs.flatMap((s) => segs[s].nodes)
    let pts = pathNodes.map((n) => lps(n))
    let rs = pathNodes.map((n) => nodes[n].r * MODEL_TO_MM)
    const median = (arr, i, w) => {
      const win = arr.slice(Math.max(0, i - w), i + w + 1).sort((a, b) => a - b)
      return win[Math.floor(win.length / 2)]
    }
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
    def.hit = labelNodes(def.id)
      .filter((_, i) => i % 2 === 0)
      .map((n) => lps(n).map((v) => +v.toFixed(1)))
    qa.push(
      `${system}/${def.id}: anchor Δ${def.anchorDist.toFixed(1)}mm, centerline ${out.length} pts ${length.toFixed(0)} mm, mean r ${(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(2)} mm, hit pts ${def.hit.length}, end [${out[out.length - 1].slice(0, 3).map((v) => v.toFixed(0))}]`,
    )
    if (def.id === 'LCx' || def.id === 'RCA') avGroovePoints.push(...out.map((p) => p.slice(0, 3)))
  }

  // split the surface by label (triangle majority vote), remapping vertices
  for (const def of defs) {
    const tris = []
    for (const t of comp.tris) {
      const a = art.idx[3 * t]
      const b = art.idx[3 * t + 1]
      const c = art.idx[3 * t + 2]
      const la = vLabel.get(a)
      const lb = vLabel.get(b)
      const lc = vLabel.get(c)
      const L = la === lb || la === lc ? la : lb === lc ? lb : la
      if (L === def.id) tris.push(a, b, c)
    }
    if (!tris.length) {
      log(`  (no triangles for ${system}/${def.id})`)
      continue
    }
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
        p.push(artLps.p[3 * v], artLps.p[3 * v + 1], artLps.p[3 * v + 2])
        n.push(artNormalsLps[3 * v], artNormalsLps[3 * v + 1], artNormalsLps[3 * v + 2])
        r.push(vRad.get(v))
        ax.push(...vAxis.get(v))
      }
      idx.push(i)
    }
    branchMeshes.push({ system, def, p: Float32Array.from(p), n: Float32Array.from(n), r: Float32Array.from(r), ax: Float32Array.from(ax), idx: Uint32Array.from(idx) })
  }
}
log('\n--- coronary branches ---')
qa.forEach((l) => log(l))
log(`coronary meshes: ${branchMeshes.length}, tris ${branchMeshes.reduce((s, b) => s + b.idx.length / 3, 0)}, verts ${branchMeshes.reduce((s, b) => s + b.p.length / 3, 0)}`)
for (const b of branchMeshes) log(`  ${b.system}_${b.def.id}: ${b.idx.length / 3} tris`)

// ---------------------------------------------------------------------------------------------- 3. atrial / ventricular colouring
// AV groove plane from the LCx + RCA centerlines (PCA normal); atria on the cranial-posterior side.
const gc = avGroovePoints.reduce((s, p) => [s[0] + p[0], s[1] + p[1], s[2] + p[2]], [0, 0, 0]).map((v) => v / avGroovePoints.length)
const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
for (const p of avGroovePoints) {
  const d = sub(p, gc)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j]
}
const mulC = (v) => [0, 1, 2].map((i) => C[i][0] * v[0] + C[i][1] * v[1] + C[i][2] * v[2])
const power = (v, deflate) => {
  for (let k = 0; k < 200; k++) {
    v = norm(mulC(v))
    if (deflate) {
      const d = dot(v, deflate)
      v = norm(v.map((x, i) => x - d * deflate[i]))
    }
  }
  return v
}
const e1 = power([1, 0.3, 0.2])
const e2 = power([0.2, 1, 0.3], e1)
let nAV = norm(cross(e1, e2))
if (dot(nAV, [-0.3, 0.45, 0.85]) < 0) nAV = nAV.map((v) => -v)
log(`AV groove plane: centre [${gc.map((v) => v.toFixed(0))}] normal [${nAV.map((v) => v.toFixed(2))}] (atria on the + side)`)
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const ventricle = [0xc9 / 255, 0x76 / 255, 0x5f / 255]
const atrium = [0x8e / 255, 0xa3 / 255, 0xbd / 255]
const myoColors = new Float32Array(soft.Myocardium.p.length)
for (let i = 0; i < soft.Myocardium.p.length; i += 3) {
  const s = dot(sub([soft.Myocardium.p[i], soft.Myocardium.p[i + 1], soft.Myocardium.p[i + 2]], gc), nAV)
  const t = smooth(-5, 5, s)
  for (let k = 0; k < 3; k++) myoColors[i + k] = ventricle[k] + (atrium[k] - ventricle[k]) * t
}

// ---------------------------------------------------------------------------------------------- 4. write GLB
const doc = new Document()
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER })
const buffer = doc.createBuffer()
const scene = doc.createScene('CathSimHeart').setExtras({
  coordinateSystem: 'LPS mm: +X patient left, +Y posterior, +Z cranial; isocenter at origin',
  source: 'anatomical-heart-codominance (FBX, rechts dominant versie 1)',
  modelToMm: MODEL_TO_MM,
  isocenterModelUnits: centroid.map((v) => +v.toFixed(2)),
  avPlane: { point: gc.map((v) => +v.toFixed(2)), normal: nAV.map((v) => +v.toFixed(4)) },
})
doc.getRoot().setDefaultScene(scene)
const accessor = (data, type) => doc.createAccessor().setArray(data).setType(type).setBuffer(buffer)
/** Unit vectors as normalised int8 (precision 1/127, about 0.45 degrees): 12 → 4 bytes per vertex. */
const unitInt8 = (data, type) => doc.createAccessor().setArray(Int8Array.from(data, (v) => Math.round(v * 127))).setType(type).setNormalized(true).setBuffer(buffer)
const addMesh = (name, { p, idx }, attrs, extras) => {
  const prim = doc
    .createPrimitive()
    .setIndices(accessor(idx, 'SCALAR'))
    .setAttribute('POSITION', accessor(p, 'VEC3'))
    .setAttribute('NORMAL', unitInt8(attrs.normal ?? vertexNormals({ p, idx }), 'VEC3'))
  if (attrs.color) prim.setAttribute('COLOR_0', accessor(attrs.color, 'VEC3'))
  if (attrs.radius) prim.setAttribute('_RADIUS', accessor(attrs.radius, 'SCALAR'))
  if (attrs.axis) prim.setAttribute('_AXIS', unitInt8(attrs.axis, 'VEC3'))
  const mesh = doc.createMesh(name).addPrimitive(prim)
  scene.addChild(doc.createNode(name).setMesh(mesh).setExtras(extras))
}
addMesh('SoftTissueEnvelope', envelope, {}, { kind: 'shadow', id: 'SoftTissueEnvelope', label: 'Filled cardiac volume (fluoro soft-tissue shadow)' })
addMesh('Myocardium', soft.Myocardium, { color: myoColors }, { kind: 'silhouette', id: 'Myocardium', label: 'Ventricles and atria' })
addMesh('LeftAtrialAppendage', soft.LeftAtrialAppendage, {}, { kind: 'silhouette', id: 'LeftAtrialAppendage', label: 'Left atrial appendage' })
addMesh('Aorta', soft.Aorta, {}, { kind: 'silhouette', id: 'Aorta', label: 'Aortic root and ascending aorta' })
addMesh('PulmonaryTrunk', soft.PulmonaryTrunk, {}, { kind: 'silhouette', id: 'PulmonaryTrunk', label: 'Pulmonary trunk' })
for (const b of branchMeshes) {
  addMesh(`${b.system}_${b.def.id}`, { p: b.p, idx: b.idx }, { normal: b.n, radius: b.r, axis: b.ax }, {
    kind: 'coronary',
    system: b.system,
    id: b.def.id,
    label: b.def.label,
  })
}
mkdirSync(dirname(OUT), { recursive: true })
const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder })
await io.write(OUT, doc)
const indexPath = OUT.replace(/\.glb$/, '.index.json')

// Orienting landmarks (index v2), placed from the filled envelope because this model has no spine or diaphragm of its own.
// Diaphragm dome apex 12 mm under the lowest point of the heart (the rim then falls 45 mm lower, see lib/landmarks.ts);
// vertebral column centred on the heart's x, 16 mm behind its most posterior point (left atrium / pulmonary-vein stumps),
// which leaves room for the descending aorta and oesophagus between them.
const env = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
for (let i = 0; i < envelope.p.length; i += 3) {
  for (let k = 0; k < 3; k++) {
    env.min[k] = Math.min(env.min[k], envelope.p[i + k])
    env.max[k] = Math.max(env.max[k], envelope.p[i + k])
  }
}
const envCentre = env.min.map((v, k) => (v + env.max[k]) / 2)
const spineX = Math.round(envCentre[0])
const spineY = Math.round(env.max[1] + 16)
const landmarks = {
  diaphragm_apex: [spineX, Math.round(envCentre[1]), Math.round(env.min[2] - 12)],
  spine: { centres: [-60, 0, 60].map((z) => [spineX, spineY, z]), radius_mm: 13 },
  placement: 'derived from the SoftTissueEnvelope bounds (no CT)',
}
log(`landmarks: diaphragm apex [${landmarks.diaphragm_apex}], spine centre (${spineX}, ${spineY}), envelope min [${env.min.map((v) => v.toFixed(0))}] max [${env.max.map((v) => v.toFixed(0))}]`)

const index = {
  version: 2,
  meta: {
    case_id: 'heart',
    frame: 'LPS mm: +X patient left, +Y posterior, +Z cranial; isocenter at origin',
    qc_status: 'n/a (curated anatomical model, not a patient scan)',
    coronary_method: 'curated skeleton labelling of the sculpted Sketchfab model (scripts/build-heart.mjs, anchors pinned to segment ids)',
    provisional_labels: false,
  },
  coordinateSystem: 'LPS mm: +X patient left, +Y posterior, +Z cranial; isocenter at origin',
  source: 'anatomical-heart-codominance (rechts dominant versie 1.fbx)',
  modelToMm: MODEL_TO_MM,
  avPlane: { point: gc.map((v) => +v.toFixed(2)), normal: nAV.map((v) => +v.toFixed(4)) },
  landmarks,
  branches: branchMeshes.map((b) => ({
    system: b.system,
    id: b.def.id,
    label: b.def.label,
    labelT: b.def.labelT,
    lengthMm: +b.def.length.toFixed(1),
    /** [x, y, z, lumen radius] every ~2 mm along the main path, origin to distal. */
    centerline: b.def.centerline,
    /** every point of the branch's whole group (incl. unnamed twigs), for tap hit-testing. */
    hit: b.def.hit,
  })),
}
writeFileSync(indexPath, JSON.stringify(index))

// One-case library manifest next to the model (the app is manifest-driven; see lib/heartIndex.ts).
const stem = OUT.replace(/\\/g, '/').split('/').pop().replace(/\.glb$/, '')
const manifest = {
  version: 1,
  note: 'Curated anatomical heart (Sketchfab model, scripts/build-heart.mjs). Frame: LPS mm, isocenter (0,0,0) = myocardium volume centroid. The earlier CT-derived patient library is kept outside public/ (build/cohort_library).',
  default: stem,
  cases: [
    {
      id: stem,
      number: 1,
      displayName: 'Case 1',
      label: 'Case 1: Standard Anatomy',
      variantNote: 'Standard anatomy',
      branches: branchMeshes.map((b) => b.def.id),
      labeling: 'curated',
      provisional: false,
    },
  ],
}
writeFileSync(OUT.replace(/[^/\\]+$/, 'cases_manifest.json'), JSON.stringify(manifest, null, 1))
log(`\nwrote ${OUT}: ${(statSync(OUT).size / 1024).toFixed(0)} KB, ${indexPath}: ${(statSync(indexPath).size / 1024).toFixed(0)} KB`)
