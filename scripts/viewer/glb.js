// Dev-only: QA render of public/models/heart.glb in patient LPS space. Camera views are named by the detector position.
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
const W = 1600, H = 1000
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(W, H); renderer.setScissorTest(true); document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x15181d)
const light = new THREE.DirectionalLight(0xffffff, 2.2); scene.add(light, new THREE.AmbientLight(0xffffff, 1))
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder)
const gltf = await new Promise((res, rej) => loader.load('/models/heart.glb', res, undefined, rej))
const palette = { LM: 0xff2d2d, LAD: 0xff8a00, D1: 0xffe14d, D2: 0xb6ff4d, LCx: 0x2dff9a, OM1: 0x2de0ff, RCA: 0xc77dff, AM: 0xff6bd6, PDA: 0xffffff, PLB: 0x7d8bff }
const info = []
gltf.scene.traverse((o) => {
  if (!o.isMesh) return
  const ex = o.userData || {}
  const attrs = Object.keys(o.geometry.attributes).join(',')
  info.push(`${o.name} verts ${o.geometry.attributes.position.count} attrs[${attrs}] kind=${ex.kind} ${ex.id ?? ''}`)
  if (ex.kind === 'coronary') o.material = new THREE.MeshLambertMaterial({ color: palette[ex.id] ?? 0xffffff, side: THREE.DoubleSide })
  else o.material = new THREE.MeshLambertMaterial({ vertexColors: !!o.geometry.attributes.color, color: o.geometry.attributes.color ? 0xffffff : 0x9aa6b8, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.FrontSide })
})
scene.add(gltf.scene)
window.__info = info
const s = 105
const views = [['AP: detector anterior (-Y)', [0, -1, 0], [0, 0, 1]], ['PA: detector posterior (+Y)', [0, 1, 0], [0, 0, 1]], ['LAO 90: detector patient-left (+X)', [1, 0, 0], [0, 0, 1]], ['inferior (-Z)', [0, 0, -1], [0, -1, 0]], ['LAO 45', [0.7071, -0.7071, 0], [0, 0, 1]], ['RAO 45', [-0.7071, -0.7071, 0], [0, 0, 1]]]
const tw = W / 3, th = H / 2
views.forEach(([, dir, up], i) => {
  const cam = new THREE.OrthographicCamera(-s * (tw / th), s * (tw / th), s, -s, 0.1, 5000)
  cam.up.set(...up); cam.position.set(dir[0] * 900, dir[1] * 900, dir[2] * 900)
  // operator view = looking from the detector side towards the isocenter (no mirroring)
  cam.lookAt(0, 0, 0)
  light.position.copy(cam.position)
  const x = (i % 3) * tw, y = H - (Math.floor(i / 3) + 1) * th
  renderer.setViewport(x, y, tw, th); renderer.setScissor(x, y, tw, th); renderer.render(scene, cam)
})
document.title = 'done'
