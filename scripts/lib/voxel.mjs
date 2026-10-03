// Filled-volume envelope of a set of (possibly hollow, possibly overlapping) closed surface meshes.
//   rasterize shells → dilate → flood-fill the exterior → solid = not exterior → erode → blur → naive surface nets.
// The result is a watertight, outward-wound mesh of the union volume with all internal cavities filled, which is what a
// soft-tissue X-ray shadow needs (blood and muscle attenuate alike, so chambers are not "empty").

export function buildEnvelope(meshes, h = 1.25, closeMm = 14) {
  const margin = Math.ceil(closeMm / h) + 3
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const { p } of meshes) {
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[i + k])
      max[k] = Math.max(max[k], p[i + k])
    }
  }
  const dims = [0, 1, 2].map((k) => Math.ceil((max[k] - min[k]) / h) + 2 * margin + 1)
  const [nx, ny, nz] = dims
  const N = nx * ny * nz
  const at = (i, j, k) => i + nx * (j + ny * k)
  const origin = min.map((v) => v - margin * h)

  // 1. rasterise triangle surfaces (dense barycentric sampling, spacing h/3, so no voxel the surface crosses is missed)
  const shell = new Uint8Array(N)
  const mark = (x, y, z) => {
    const i = Math.floor((x - origin[0]) / h), j = Math.floor((y - origin[1]) / h), k = Math.floor((z - origin[2]) / h)
    shell[at(i, j, k)] = 1
  }
  for (const { p, idx } of meshes) {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
      const edge = Math.max(
        Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]),
        Math.hypot(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]),
        Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]),
      )
      const n = Math.max(1, Math.ceil(edge / (h / 3)))
      for (let u = 0; u <= n; u++) for (let v = 0; v <= n - u; v++) {
        const fu = u / n, fv = v / n, fw = 1 - fu - fv
        mark(fw * p[a] + fu * p[b] + fv * p[c], fw * p[a + 1] + fu * p[b + 1] + fv * p[c + 1], fw * p[a + 2] + fu * p[b + 2] + fv * p[c + 2])
      }
    }
  }

  // 2-4. morphological closing with an exact Euclidean distance transform. The source surface wraps around the rims of the
  // cut vessel stumps (SVC, IVC, pulmonary veins) and valve orifices, so every chamber is open to the outside through
  // mouths up to ~28 mm wide. Dilating the shell by r > mouth radius seals them; the exterior is then flood-filled and the
  // solid is eroded by the same r, which restores the original outer boundary. Gaps narrower than 2r (the clefts between
  // the great vessels and the atria) are bridged, as the mediastinal soft tissue does on a real fluoro.
  const r2 = (closeMm / h) ** 2
  const dShell = edtSquared(shell, dims)
  const exterior = new Uint8Array(N)
  const stack = [at(0, 0, 0)]
  exterior[stack[0]] = 1
  while (stack.length) {
    const v = stack.pop()
    const i = v % nx, j = Math.floor(v / nx) % ny, k = Math.floor(v / (nx * ny))
    const push = (ii, jj, kk) => {
      if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) return
      const w = at(ii, jj, kk)
      if (!exterior[w] && dShell[w] > r2) {
        exterior[w] = 1
        stack.push(w)
      }
    }
    push(i - 1, j, k); push(i + 1, j, k); push(i, j - 1, k); push(i, j + 1, k); push(i, j, k - 1); push(i, j, k + 1)
  }
  const dExterior = edtSquared(exterior, dims)
  let solid = new Uint8Array(N)
  let solidCount = 0
  for (let v = 0; v < N; v++) {
    if (dExterior[v] > r2 || shell[v]) { solid[v] = 1; solidCount++ }
  }

  // 5. smooth the binary volume into a scalar field (two [1 2 1]/4 passes per axis ≈ gaussian sigma ~ 1 voxel)
  let field = Float32Array.from(solid)
  const tmp = new Float32Array(N)
  const blur = (stride, count, lines) => {
    for (let pass = 0; pass < 2; pass++) {
      for (const base of lines) {
        for (let s = 1; s < count - 1; s++) {
          const v = base + s * stride
          tmp[v] = 0.25 * field[v - stride] + 0.5 * field[v] + 0.25 * field[v + stride]
        }
        for (let s = 1; s < count - 1; s++) field[base + s * stride] = tmp[base + s * stride]
      }
    }
  }
  const linesX = [], linesY = [], linesZ = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) linesX.push(at(0, j, k))
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) linesY.push(at(i, 0, k))
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) linesZ.push(at(i, j, 0))
  blur(1, nx, linesX); blur(nx, ny, linesY); blur(nx * ny, nz, linesZ)

  const mesh = surfaceNets(field, dims, origin, h, 0.5)
  return { mesh, stats: { dims, voxels: N, solidVoxels: solidCount, shellVoxels: shell.reduce((s, v) => s + v, 0), h } }
}

/** Naive surface nets (Lysenko). Field > iso is inside. Returns { p: Float32Array, idx: Uint32Array } wound outward. */
function surfaceNets(field, [nx, ny, nz], origin, h, iso) {
  const at = (i, j, k) => i + nx * (j + ny * k)
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1)
  const positions = []
  const cornerOffsets = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]]
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]]
  const val = new Float32Array(8)
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0
    for (let c = 0; c < 8; c++) {
      const [di, dj, dk] = cornerOffsets[c]
      val[c] = field[at(i + di, j + dj, k + dk)]
      if (val[c] > iso) mask |= 1 << c
    }
    if (mask === 0 || mask === 255) continue
    let sx = 0, sy = 0, sz = 0, n = 0
    for (const [a, b] of edges) {
      if ((val[a] > iso) === (val[b] > iso)) continue
      const t = (iso - val[a]) / (val[b] - val[a])
      sx += cornerOffsets[a][0] + t * (cornerOffsets[b][0] - cornerOffsets[a][0])
      sy += cornerOffsets[a][1] + t * (cornerOffsets[b][1] - cornerOffsets[a][1])
      sz += cornerOffsets[a][2] + t * (cornerOffsets[b][2] - cornerOffsets[a][2])
      n++
    }
    cellVertex[at(i, j, k)] = positions.length / 3
    positions.push(origin[0] + (i + sx / n) * h, origin[1] + (j + sy / n) * h, origin[2] + (k + sz / n) * h)
  }
  const indices = []
  const quad = (a, b, c, d, flip) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) indices.push(a, d, c, a, c, b)
    else indices.push(a, b, c, a, c, d)
  }
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const here = field[at(i, j, k)] > iso
    // x-edge (i,j,k)-(i+1,j,k): cells (i, j-1..j, k-1..k)
    if (here !== field[at(i + 1, j, k)] > iso) quad(cellVertex[at(i, j - 1, k - 1)], cellVertex[at(i, j, k - 1)], cellVertex[at(i, j, k)], cellVertex[at(i, j - 1, k)], !here)
    // y-edge: cells (i-1..i, j, k-1..k)
    if (here !== field[at(i, j + 1, k)] > iso) quad(cellVertex[at(i - 1, j, k - 1)], cellVertex[at(i - 1, j, k)], cellVertex[at(i, j, k)], cellVertex[at(i, j, k - 1)], !here)
    // z-edge: cells (i-1..i, j-1..j, k)
    if (here !== field[at(i, j, k + 1)] > iso) quad(cellVertex[at(i - 1, j - 1, k)], cellVertex[at(i, j - 1, k)], cellVertex[at(i, j, k)], cellVertex[at(i - 1, j, k)], !here)
  }
  return { p: Float32Array.from(positions), idx: Uint32Array.from(indices) }
}

/**
 * Exact squared Euclidean distance (in voxel units) from every voxel to the nearest set voxel of `mask`
 * (Felzenszwalb & Huttenlocher, separable 1D lower-envelope passes). Unset-everywhere masks give Infinity.
 */
export function edtSquared(mask, [nx, ny, nz]) {
  const INF = 1e12
  const N = nx * ny * nz
  const d = new Float64Array(N)
  for (let i = 0; i < N; i++) d[i] = mask[i] ? 0 : INF
  const maxLen = Math.max(nx, ny, nz)
  const f = new Float64Array(maxLen), out = new Float64Array(maxLen), v = new Int32Array(maxLen), z = new Float64Array(maxLen + 1)
  const pass = (count, stride, starts) => {
    for (const base of starts) {
      for (let q = 0; q < count; q++) f[q] = d[base + q * stride]
      let k = 0
      v[0] = 0; z[0] = -INF; z[1] = INF
      for (let q = 1; q < count; q++) {
        let s
        for (;;) {
          s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
          if (s <= z[k] && k > 0) k--
          else break
        }
        if (s <= z[k]) { v[k] = q; z[k] = -INF; z[k + 1] = INF } else { k++; v[k] = q; z[k] = s; z[k + 1] = INF }
      }
      k = 0
      for (let q = 0; q < count; q++) {
        while (z[k + 1] < q) k++
        out[q] = (q - v[k]) * (q - v[k]) + f[v[k]]
      }
      for (let q = 0; q < count; q++) d[base + q * stride] = out[q]
    }
  }
  const xs = [], ys = [], zs = []
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) xs.push(nx * (j + ny * k))
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) ys.push(i + nx * ny * k)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) zs.push(i + nx * j)
  pass(nx, 1, xs); pass(ny, nx, ys); pass(nz, nx * ny, zs)
  return d
}
