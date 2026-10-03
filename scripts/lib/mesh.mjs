// Shared mesh helpers for the build scripts (Node, no DOM): FBX loading, welding, adjacency, Dijkstra, skeleton.
import { readFileSync } from 'node:fs'
import { BufferGeometry, Float32BufferAttribute, Texture, TextureLoader } from 'three'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

export function loadFbx(file) {
  globalThis.window ??= { innerWidth: 1, innerHeight: 1 } // FBXLoader sizes imported cameras from the window
  TextureLoader.prototype.load = () => new Texture() // geometry only
  const origWarn = console.warn
  console.warn = () => {}
  const buf = readFileSync(file)
  const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '')
  console.warn = origWarn
  root.updateMatrixWorld(true)
  return root
}

/** World-space, position-only, welded (1e-3) indexed mesh of a Three mesh: { p: Float32Array, idx: Uint32Array }. */
export function weldedMesh(mesh) {
  const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  const bare = new BufferGeometry()
  bare.setAttribute('position', new Float32BufferAttribute(Array.from(g.getAttribute('position').array), 3))
  const w = mergeVertices(bare, 1e-3)
  return { p: Float32Array.from(w.getAttribute('position').array), idx: Uint32Array.from(w.getIndex().array) }
}

/** Connected components of a welded mesh → array of { verts:Int32Array, tris:Int32Array }. */
export function components({ p, idx }) {
  const nv = p.length / 3
  const parent = Int32Array.from({ length: nv }, (_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  for (let t = 0; t < idx.length; t += 3) { parent[find(idx[t])] = find(idx[t + 1]); parent[find(idx[t + 1])] = find(idx[t + 2]) }
  const vmap = new Map(), tmap = new Map()
  for (let v = 0; v < nv; v++) { const r = find(v); (vmap.get(r) ?? vmap.set(r, []).get(r)).push(v) }
  for (let t = 0; t < idx.length / 3; t++) { const r = find(idx[3 * t]); (tmap.get(r) ?? tmap.set(r, []).get(r)).push(t) }
  return [...vmap.keys()].map((r) => ({ verts: Int32Array.from(vmap.get(r)), tris: Int32Array.from(tmap.get(r) ?? []) })).sort((a, b) => b.verts.length - a.verts.length)
}

export function adjacency({ p, idx }) {
  const nv = p.length / 3
  const adj = Array.from({ length: nv }, () => new Map())
  const add = (a, b) => {
    if (adj[a].has(b)) return
    const d = Math.hypot(p[3*a]-p[3*b], p[3*a+1]-p[3*b+1], p[3*a+2]-p[3*b+2])
    adj[a].set(b, d); adj[b].set(a, d)
  }
  for (let t = 0; t < idx.length; t += 3) { add(idx[t], idx[t+1]); add(idx[t+1], idx[t+2]); add(idx[t+2], idx[t]) }
  return adj
}

export function dijkstra(adj, source, allowed) {
  const n = adj.length
  const dist = new Float64Array(n).fill(Infinity)
  const heap = [[0, source]]
  dist[source] = 0
  const push = (item) => { heap.push(item); let i = heap.length - 1; while (i > 0) { const par = (i - 1) >> 1; if (heap[par][0] <= heap[i][0]) break; [heap[par], heap[i]] = [heap[i], heap[par]]; i = par } }
  const pop = () => { const top = heap[0]; const last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let l = 2*i+1, r = l+1, m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m } } return top }
  while (heap.length) {
    const [d, u] = pop()
    if (d > dist[u]) continue
    for (const [v, w] of adj[u]) { if (allowed && !allowed[v]) continue; const nd = d + w; if (nd < dist[v]) { dist[v] = nd; push([nd, v]) } }
  }
  return dist
}

/**
 * Geodesic level-set skeleton of a tubular tree. Vertices are binned by geodesic distance from the root; each bin is
 * split into connected pieces (mesh edges inside the bin); every piece is a skeleton node (centroid + mean radius);
 * a node's parent is the piece in the previous bin it touches. Returns nodes[] with { bin, verts, c:[x,y,z], r, parent, children }.
 */
export function levelSetSkeleton({ p }, adj, dist, vertsOf, step) {
  const bins = new Map()
  for (const v of vertsOf) { const k = Math.floor(dist[v] / step); (bins.get(k) ?? bins.set(k, []).get(k)).push(v) }
  const nodeOf = new Int32Array(adj.length).fill(-1)
  const nodes = []
  for (const k of [...bins.keys()].sort((a, b) => a - b)) {
    const verts = bins.get(k)
    const seen = new Set()
    for (const s of verts) {
      if (seen.has(s)) continue
      const piece = [], stack = [s]
      seen.add(s)
      while (stack.length) { const u = stack.pop(); piece.push(u); for (const v of adj[u].keys()) if (!seen.has(v) && Math.floor(dist[v] / step) === k && nodeOf[v] === -1) { seen.add(v); stack.push(v) } }
      const id = nodes.length
      let cx = 0, cy = 0, cz = 0
      for (const v of piece) { cx += p[3*v]; cy += p[3*v+1]; cz += p[3*v+2]; nodeOf[v] = id }
      cx /= piece.length; cy /= piece.length; cz /= piece.length
      let r = 0
      for (const v of piece) r += Math.hypot(p[3*v]-cx, p[3*v+1]-cy, p[3*v+2]-cz)
      nodes.push({ id, bin: k, verts: piece, c: [cx, cy, cz], r: r / piece.length, parent: -1, children: [] })
    }
  }
  for (const nd of nodes) {
    const votes = new Map()
    for (const v of nd.verts) for (const u of adj[v].keys()) { const o = nodeOf[u]; if (o >= 0 && nodes[o].bin === nd.bin - 1) votes.set(o, (votes.get(o) || 0) + 1) }
    let best = -1, bc = 0
    for (const [o, c] of votes) if (c > bc) { bc = c; best = o }
    nd.parent = best
    if (best >= 0) nodes[best].children.push(nd.id)
  }
  return { nodes, nodeOf }
}

/** Drop skeleton tips shorter than `minDepth` bins (iterative: depth = bins from the node to its deepest descendant). */
export function pruneSkeleton(nodes, minDepth) {
  const depth = new Int32Array(nodes.length)
  for (let i = nodes.length - 1; i >= 0; i--) {
    let d = 0
    for (const c of nodes[i].children) d = Math.max(d, depth[c] + 1)
    depth[i] = d
  }
  const keep = nodes.map((n, i) => n.parent < 0 || depth[i] >= minDepth)
  // a node is kept only if its whole ancestor chain is kept (depth is monotone along ancestors, so this holds)
  for (const n of nodes) n.children = n.children.filter((c) => keep[c])
  return { keep, depth }
}

// ---------------------------------------------------------------------------------------------------------------
// Dense surface-sample graph: robust geodesic level sets on meshes with long skinny triangles.
// ---------------------------------------------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Area-weighted random surface samples of the given triangles. Returns { pts: Float32Array(3n), tri: Int32Array(n) }. */
export function sampleSurface({ p, idx }, triList, spacing, seed = 1) {
  const rand = rng(seed)
  const areas = new Float64Array(triList.length)
  let total = 0
  for (let i = 0; i < triList.length; i++) {
    const t = triList[i], a = idx[3*t], b = idx[3*t+1], c = idx[3*t+2]
    const ux = p[3*b]-p[3*a], uy = p[3*b+1]-p[3*a+1], uz = p[3*b+2]-p[3*a+2]
    const vx = p[3*c]-p[3*a], vy = p[3*c+1]-p[3*a+1], vz = p[3*c+2]-p[3*a+2]
    areas[i] = Math.hypot(uy*vz-uz*vy, uz*vx-ux*vz, ux*vy-uy*vx) / 2
    total += areas[i]
  }
  const pts = [], tri = []
  for (let i = 0; i < triList.length; i++) {
    const t = triList[i], a = idx[3*t], b = idx[3*t+1], c = idx[3*t+2]
    const expected = areas[i] / (spacing * spacing)
    let n = Math.floor(expected); if (rand() < expected - n) n++
    for (let k = 0; k < n; k++) {
      let u = rand(), v = rand(); if (u + v > 1) { u = 1 - u; v = 1 - v }
      pts.push(p[3*a] + u*(p[3*b]-p[3*a]) + v*(p[3*c]-p[3*a]), p[3*a+1] + u*(p[3*b+1]-p[3*a+1]) + v*(p[3*c+1]-p[3*a+1]), p[3*a+2] + u*(p[3*b+2]-p[3*a+2]) + v*(p[3*c+2]-p[3*a+2]))
      tri.push(t)
    }
  }
  return { pts: Float32Array.from(pts), tri: Int32Array.from(tri), area: total }
}

/** Radius graph over points (spatial hash). Returns adjacency as arrays of Map(neighbour → distance). */
export function pointGraph(pts, linkRadius) {
  const n = pts.length / 3
  const cell = linkRadius
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`
  const grid = new Map()
  for (let i = 0; i < n; i++) { const k = key(pts[3*i], pts[3*i+1], pts[3*i+2]); (grid.get(k) ?? grid.set(k, []).get(k)).push(i) }
  const adj = Array.from({ length: n }, () => new Map())
  const r2 = linkRadius * linkRadius
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(pts[3*i] / cell), cy = Math.floor(pts[3*i+1] / cell), cz = Math.floor(pts[3*i+2] / cell)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${cx+dx},${cy+dy},${cz+dz}`)
      if (!list) continue
      for (const j of list) {
        if (j <= i) continue
        const d2 = (pts[3*i]-pts[3*j])**2 + (pts[3*i+1]-pts[3*j+1])**2 + (pts[3*i+2]-pts[3*j+2])**2
        if (d2 < r2) { const d = Math.sqrt(d2); adj[i].set(j, d); adj[j].set(i, d) }
      }
    }
  }
  return adj
}

/** Collapse a pruned skeleton into segments (chains between junctions / tips). */
export function buildSegments(nodes, keep) {
  const segs = []
  const segOf = new Int32Array(nodes.length).fill(-1)
  const rootNode = nodes.findIndex((n) => n.parent < 0)
  const kids = (i) => nodes[i].children.filter((c) => keep[c])
  const startSeg = (first, parentSeg) => {
    const seg = { id: segs.length, nodes: [], parent: parentSeg, children: [], length: 0, subtreeLength: 0 }
    segs.push(seg)
    let cur = first
    for (;;) {
      seg.nodes.push(cur); segOf[cur] = seg.id
      const k = kids(cur)
      if (k.length !== 1) { for (const c of k) seg.children.push(startSeg(c, seg.id).id); break }
      cur = k[0]
    }
    for (let i = 1; i < seg.nodes.length; i++) { const a = nodes[seg.nodes[i - 1]].c, b = nodes[seg.nodes[i]].c; seg.length += Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]) }
    return seg
  }
  startSeg(rootNode, -1)
  for (let i = segs.length - 1; i >= 0; i--) { segs[i].subtreeLength = segs[i].length + segs[i].children.reduce((s, c) => s + segs[c].subtreeLength, 0) }
  return { segs, segOf }
}
