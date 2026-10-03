// Casts AP rays (along +Y, from anterior) through a mesh of the built GLB and reports crossing structure.
//   node scripts/ray-check.mjs public/models/heart.glb Myocardium
import { NodeIO } from '@gltf-transform/core'
import { EXTMeshoptCompression } from '@gltf-transform/extensions'
import { MeshoptDecoder } from 'meshoptimizer'
await MeshoptDecoder.ready
const io = new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder })
const doc = await io.read(process.argv[2])
const node = doc.getRoot().listNodes().find((n) => n.getName() === process.argv[3])
const prim = node.getMesh().listPrimitives()[0]
const P = prim.getAttribute('POSITION').getArray(), I = prim.getIndices().getArray()
const tris = I.length / 3
function crossings(x, z) {
  const hits = []
  for (let t = 0; t < tris; t++) {
    const a = I[3*t], b = I[3*t+1], c = I[3*t+2]
    const ax = P[3*a], ay = P[3*a+1], az = P[3*a+2], bx = P[3*b], by = P[3*b+1], bz = P[3*b+2], cx = P[3*c], cy = P[3*c+1], cz = P[3*c+2]
    // ray origin (x, -1000, z) dir (0,1,0): project to XZ plane barycentric test
    const d = (bx-ax)*(cz-az) - (bz-az)*(cx-ax)
    if (Math.abs(d) < 1e-9) continue
    const u = ((x-ax)*(cz-az) - (z-az)*(cx-ax)) / d
    const v = ((bx-ax)*(z-az) - (bz-az)*(x-ax)) / d
    if (u < 0 || v < 0 || u + v > 1) continue
    const y = ay + u*(by-ay) + v*(cy-ay)
    // normal.y sign (front-facing wrt a ray travelling +y means normal.y < 0)
    const ny = (bz-az)*(cx-ax) - (bx-ax)*(cz-az)
    hits.push([y, ny < 0 ? 'in' : 'out'])
  }
  return hits.sort((p, q) => p[0] - q[0])
}
let inconsistent = 0, total = 0
const rows = []
for (let z = -60; z <= 100; z += 20) for (let x = -80; x <= 60; x += 20) {
  const h = crossings(x, z)
  if (!h.length) continue
  total++
  const seq = h.map((e) => (e[1] === 'in' ? '+' : '-')).join('')
  let depth = 0, valid = true, thickness = 0, last = 0
  for (const [y, k] of h) { if (depth > 0) thickness += y - last; depth += k === 'in' ? 1 : -1; if (depth < 0) valid = false; last = y }
  if (!valid || depth !== 0) inconsistent++
  rows.push(`x=${x} z=${z}: ${h.length} crossings [${seq}] thickness ${thickness.toFixed(0)} mm ${valid && depth === 0 ? '' : '  <-- INCONSISTENT'}`)
}
console.log(rows.join('\n'))
console.log(`\nrays hitting the mesh: ${total}, inconsistent winding/closure: ${inconsistent}`)

if (process.argv[4] === '--detail') {
  for (const [x, z] of [[0, 0], [-20, 20], [20, -20], [0, -40]]) {
    const h = crossings(x, z)
    console.log(`ray x=${x} z=${z}: ` + h.map(([y, k]) => `${k === 'in' ? '→' : '←'}${y.toFixed(0)}`).join('  '))
  }
}
