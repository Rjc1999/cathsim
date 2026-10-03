import { BufferGeometry, Float32BufferAttribute, type CatmullRomCurve3 } from 'three'

/**
 * Tube geometry along a centerline with a per-vertex radius (`aRadius`, mm) and unit tangent (`aTangent`).
 * The fluoro shader needs both to compute the X-ray path length through a cylinder seen at an oblique angle.
 * (The coronary model brings its own per-vertex radius and axis; this builder now only serves the spine landmark.)
 *
 * Frames come from three's parallel-transport `computeFrenetFrames`, so the cross-section does not flip on
 * near-straight segments. The vertex normal is the radial direction (exact for a constant radius, a close
 * approximation for the gentle tapers used here).
 */
export function buildTube(
  curve: CatmullRomCurve3,
  radiusAt: (t: number) => number,
  radialSegments = 14,
  spacingMm = 1.5,
): BufferGeometry {
  const tubular = Math.max(24, Math.ceil(curve.getLength() / spacingMm))
  const frames = curve.computeFrenetFrames(tubular, false)

  const positions: number[] = []
  const normals: number[] = []
  const radii: number[] = []
  const tangents: number[] = []
  const indices: number[] = []

  for (let i = 0; i <= tubular; i++) {
    const t = i / tubular
    const c = curve.getPointAt(t)
    const tan = frames.tangents[i]
    const n = frames.normals[i]
    const b = frames.binormals[i]
    const r = radiusAt(t)

    for (let j = 0; j <= radialSegments; j++) {
      const v = (j / radialSegments) * Math.PI * 2
      const cos = Math.cos(v)
      const sin = Math.sin(v)
      const nx = cos * n.x + sin * b.x
      const ny = cos * n.y + sin * b.y
      const nz = cos * n.z + sin * b.z
      positions.push(c.x + r * nx, c.y + r * ny, c.z + r * nz)
      normals.push(nx, ny, nz)
      radii.push(r)
      tangents.push(tan.x, tan.y, tan.z)
    }
  }

  const stride = radialSegments + 1
  for (let i = 0; i < tubular; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * stride + j
      const b = (i + 1) * stride + j
      indices.push(a, b, a + 1, b, b + 1, a + 1)
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  geometry.setAttribute('aRadius', new Float32BufferAttribute(radii, 1))
  geometry.setAttribute('aTangent', new Float32BufferAttribute(tangents, 3))
  geometry.setIndex(indices)
  geometry.computeBoundingSphere()
  return geometry
}

/** Give a non-tube geometry (e.g. a sphere shell) the attributes the attenuation shader expects. */
export function withAttenuatorAttributes(geometry: BufferGeometry): BufferGeometry {
  const count = geometry.getAttribute('position').count
  geometry.setAttribute('aRadius', new Float32BufferAttribute(new Float32Array(count), 1))
  geometry.setAttribute('aTangent', new Float32BufferAttribute(new Float32Array(count * 3), 3))
  return geometry
}
