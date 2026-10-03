// Dumps the scene graph of an FBX: node names, materials, vertex counts, world-space bounding boxes.
// Usage: node scripts/inspect-fbx.mjs <file.fbx> [--json out.json]
import { readFileSync, writeFileSync } from 'node:fs'
import { Box3, Texture, TextureLoader, Vector3 } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'

// Node has no DOM: geometry is all we need, so texture loads become empty placeholders (their names are still logged).
globalThis.window ??= { innerWidth: 1, innerHeight: 1 } // FBXLoader sizes imported cameras from the window
const texNames = []
TextureLoader.prototype.load = function (url) {
  texNames.push(String(url).slice(-80))
  return new Texture()
}

const file = process.argv[2]
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null
const buf = readFileSync(file)
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
const root = new FBXLoader().parse(ab, '')
root.updateMatrixWorld(true)

const rows = []
const size = new Vector3(), center = new Vector3()
function walk(o, depth) {
  const box = new Box3().setFromObject(o)
  const isMesh = o.isMesh
  const mats = isMesh ? (Array.isArray(o.material) ? o.material : [o.material]).map((m) => `${m.name || '(unnamed)'}[${m.type}${m.color ? ' #' + m.color.getHexString() : ''}${m.map ? ' tex' : ''}]`) : []
  const verts = isMesh ? o.geometry.attributes.position.count : 0
  const tris = isMesh ? (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3 : 0
  box.getSize(size); box.getCenter(center)
  rows.push({ depth, name: o.name || '(unnamed)', type: o.type, verts, tris, mats, size: size.toArray().map((v) => +v.toFixed(2)), center: center.toArray().map((v) => +v.toFixed(2)), min: box.min.toArray().map((v) => +v.toFixed(2)), max: box.max.toArray().map((v) => +v.toFixed(2)), scale: o.scale.toArray().map((v) => +v.toFixed(4)), rot: [o.rotation.x, o.rotation.y, o.rotation.z].map((v) => +v.toFixed(3)), pos: o.position.toArray().map((v) => +v.toFixed(2)) })
  o.children.forEach((c) => walk(c, depth + 1))
}
walk(root, 0)
for (const r of rows) console.log(`${'  '.repeat(r.depth)}${r.name} <${r.type}> v=${r.verts} t=${r.tris} size=${r.size} c=${r.center}${r.mats.length ? ' mats=' + r.mats.join(',') : ''}`)
const total = new Box3().setFromObject(root)
console.log('\nTOTAL bbox min', total.min.toArray().map((v) => +v.toFixed(2)), 'max', total.max.toArray().map((v) => +v.toFixed(2)), 'size', total.getSize(new Vector3()).toArray().map((v) => +v.toFixed(2)))
console.log('meshes:', rows.filter((r) => r.type === 'Mesh' || r.type === 'SkinnedMesh').length, 'total verts:', rows.reduce((s, r) => s + r.verts, 0), 'total tris:', rows.reduce((s, r) => s + r.tris, 0))
console.log('textures referenced:', texNames.length ? texNames : 'none')
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1))
