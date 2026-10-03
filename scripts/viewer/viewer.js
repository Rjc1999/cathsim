// Dev-only inspector: renders the raw FBX from six axis-aligned orthographic views, one colour per mesh.
import * as THREE from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'

const params = new URLSearchParams(location.search)
const url = params.get('src') || '/anatomical-heart-codominance/source/rechts%20dominant%20versie%201.fbx'
const hide = (params.get('hide') || '').split(',').filter(Boolean)
const only = (params.get('only') || '').split(',').filter(Boolean)
const colors = { Hart_basis: 0xc9765f, Valves: 0xffe14d, Avvalves: 0xff9a3d, Aorta: 0xd23c3c, Veins: 0x4f7fff, Heartear: 0xff9ec2, Arteries2: 0x22e08a, Ligament: 0xb36bff, Pulmonary_trunk: 0x27d3e6 }

const W = 1500, H = 1000
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setSize(W, H)
renderer.setScissorTest(true)
document.body.appendChild(renderer.domElement)
const scene = new THREE.Scene()
scene.background = new THREE.Color(0x15181d)
const light = new THREE.DirectionalLight(0xffffff, 2.5)
scene.add(light, new THREE.AmbientLight(0xffffff, 0.8))

new FBXLoader().load(url, (obj) => {
  obj.traverse((o) => {
    if (o.isMesh) {
      const c = colors[o.name] ?? 0x888888
      o.material = new THREE.MeshLambertMaterial({ color: c, side: THREE.DoubleSide, transparent: !!params.get('alpha'), opacity: Number(params.get('alpha') || 1) })
      if (hide.includes(o.name) || (only.length && !only.includes(o.name))) o.visible = false
    }
  })
  scene.add(obj)
  const box = new THREE.Box3().setFromObject(obj)
  const c = box.getCenter(new THREE.Vector3())
  const s = Math.max(...box.getSize(new THREE.Vector3())) * 0.6
  window.__box = { min: box.min.toArray(), max: box.max.toArray() }
  // [label, direction camera sits at, up vector]
  const views = [
    ['from +X (looking -X)', [1, 0, 0], [0, 1, 0]],
    ['from -X', [-1, 0, 0], [0, 1, 0]],
    ['from +Y (top)', [0, 1, 0], [0, 0, -1]],
    ['from -Y (bottom)', [0, -1, 0], [0, 0, 1]],
    ['from +Z', [0, 0, 1], [0, 1, 0]],
    ['from -Z', [0, 0, -1], [0, 1, 0]],
  ]
  const tw = W / 3, th = H / 2
  views.forEach(([, dir, up], i) => {
    const cam = new THREE.OrthographicCamera(-s * (tw / th), s * (tw / th), s, -s, 0.1, 5000)
    cam.up.set(...up)
    cam.position.set(c.x + dir[0] * 1000, c.y + dir[1] * 1000, c.z + dir[2] * 1000)
    cam.lookAt(c)
    light.position.copy(cam.position)
    const x = (i % 3) * tw, y = H - (Math.floor(i / 3) + 1) * th
    renderer.setViewport(x, y, tw, th); renderer.setScissor(x, y, tw, th)
    renderer.render(scene, cam)
  })
  document.title = 'done'
})
