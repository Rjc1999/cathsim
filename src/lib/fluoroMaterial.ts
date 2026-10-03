import {
  AddEquation,
  CustomBlending,
  DoubleSide,
  ShaderMaterial,
  SrcColorFactor,
  Vector3,
  ZeroFactor,
} from 'three'

/**
 * Beer–Lambert attenuator material for the fluoro pass.
 *
 * Every face outputs a *transmittance* T and is blended MULTIPLICATIVELY with the framebuffer (dst = dst · T).
 * Multiplication commutes, so the result is independent of draw order (no depth sorting) and overlapping
 * structures stack and darken like real X-ray attenuation: vessels, spine and diaphragm all share this pass.
 *
 *   T = 1 − (1 − tint) · (1 − exp(−OD · density))          (tint ≈ 0 → plain exp(−OD))
 *
 * Optical density OD per face, by geometry kind:
 *  - 'tube'  (vessels, spine): half-chord of a cylinder of radius r seen along ray v with normal n and axis t:
 *        halfChord = r · |n·v| / sin²γ,   sin²γ = 1 − (t·v)²
 *    (in the cross-section plane the half-chord at offset s is sqrt(r²−s²) = r·|n·v|/sinγ, and the 3D path is
 *    that divided by sinγ again; derivation in run_log). The 1/sin²γ term makes foreshortened (end-on) segments
 *    denser, exactly as on a real angiogram. sin²γ is clamped to 0.1 (max ×10) to bound the darkening.
 *  - 'shell' (diaphragm): a thin membrane of thickness τ; path = τ / |n·v|, split over two faces; |n·v| is clamped
 *    at 0.3 so the silhouette rim is a soft dark edge rather than a singularity.
 *
 * Synthetic stenosis (tube kind only, one branch's material at a time): the vertex shader narrows the lumen around a point of the
 * branch centerline. With s the signed distance along the vessel axis from the lesion centre, L the lesion length and k the
 * diameter stenosis, a cosine window w(s) = ½(1 + cos(π s / (L/2))) for |s| < L/2 (else 0) gives the local radius
 *    r'(s) = r · (1 − k · w(s)),
 * which returns smoothly to the normal caliber at s = ±L/2. The vertices are moved so the silhouette really narrows, and r'
 * (not r) is what the Beer–Lambert chord above uses, so the waist is also lighter. A vertex at radial direction u moves by
 *    Δ = −(r − r') · (u + ε e),   ε = 0 concentric, 1 eccentric (plaque on the side e, perpendicular to the axis),
 * the exact shift for a circular section whose new circle (radius r') stays tangent to the untouched opposite wall. The
 * surface normal is tilted by the taper slope, n ≈ normalize(n − (dr'/ds)(1 + ε u·e) A), so |n·v| in the chord stays consistent.
 *
 * `tint` / `density` are per-material uniforms used for branch highlighting (cyan tint) and dimming.
 * The output is written raw to the sRGB framebuffer (no colour-space include) so the detector background stays
 * exactly #d2d7dc.
 */
export type AttenuatorKind = 'tube' | 'shell'

const vertexShader = /* glsl */ `
  attribute float aRadius;
  attribute vec3 aTangent;
  uniform float uHasLesion;
  uniform vec3 uLesionPos;
  uniform vec3 uLesionAxis;
  uniform vec3 uLesionDir;
  uniform float uLesionLength;
  uniform float uLesionSeverity;
  uniform float uLesionEcc;
  varying vec3 vNormalV;
  varying vec3 vTangentV;
  varying vec3 vPosV;
  varying float vRadius;
  void main() {
    vec3 pos = position;
    vec3 nrm = normal;
    float rad = aRadius;
    if (uHasLesion > 0.5) {
      vec3 d = position - uLesionPos;
      float s = dot(d, uLesionAxis);
      float halfL = 0.5 * uLesionLength;
      // Only this part of the vessel: inside the window along the axis and close to the axis (not a neighbouring loop).
      if (abs(s) < halfL && length(d - s * uLesionAxis) < aRadius + 3.0) {
        float ph = 3.14159265 * s / halfL;
        float w = 0.5 * (1.0 + cos(ph));
        float dw = -0.5 * sin(ph) * 3.14159265 / halfL;              // dw/ds
        float r2 = aRadius * (1.0 - uLesionSeverity * w);            // local lumen radius r'
        vec3 T = normalize(aTangent);
        vec3 u = normalize(normal - T * dot(normal, T));            // radial direction of this vertex
        pos += -(aRadius - r2) * (u + uLesionEcc * uLesionDir);
        float drds = -aRadius * uLesionSeverity * dw;                // dr'/ds
        nrm = normalize(normal - drds * (1.0 + uLesionEcc * dot(u, uLesionDir)) * uLesionAxis);
        rad = r2;
      }
    }
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vPosV = mv.xyz;
    vNormalV = normalize(normalMatrix * nrm);
    vTangentV = mat3(modelViewMatrix) * aTangent;
    vRadius = rad;
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */ `
  uniform float uMu;
  uniform float uDensity;
  uniform float uThickness;
  uniform float uShell;
  uniform vec3 uTint;
  varying vec3 vNormalV;
  varying vec3 vTangentV;
  varying vec3 vPosV;
  varying float vRadius;
  void main() {
    // Perspective view ray from the source (view-space origin) through this fragment.
    vec3 v = normalize(-vPosV);
    float nv = abs(dot(normalize(vNormalV), v));
    float od;
    if (uShell > 0.5) {
      od = uMu * uThickness * 0.5 / max(nv, 0.3);
    } else {
      float tv = dot(normalize(vTangentV), v);
      float sin2 = max(1.0 - tv * tv, 0.1);
      od = uMu * vRadius * nv / sin2;
    }
    od *= uDensity;
    vec3 t = 1.0 - (1.0 - uTint) * (1.0 - exp(-od));
    gl_FragColor = vec4(t, 1.0);
  }
`

export interface AttenuatorOptions {
  kind: AttenuatorKind
  /** Linear attenuation coefficient (1/mm), relative units: iodinated contrast ≈ 0.6, bone/soft tissue ≪ that. */
  mu: number
  /** Shell thickness τ (mm), 'shell' only. */
  thickness?: number
}

export const NEUTRAL_TINT = new Vector3(0.03, 0.03, 0.035)

export function createAttenuatorMaterial({ kind, mu, thickness = 0 }: AttenuatorOptions) {
  return new ShaderMaterial({
    uniforms: {
      uMu: { value: mu },
      uDensity: { value: 1 },
      uThickness: { value: thickness },
      uShell: { value: kind === 'shell' ? 1 : 0 },
      uTint: { value: NEUTRAL_TINT.clone() },
      uHasLesion: { value: 0 },
      uLesionPos: { value: new Vector3() },
      uLesionAxis: { value: new Vector3(0, 0, 1) },
      uLesionDir: { value: new Vector3(1, 0, 0) },
      uLesionLength: { value: 10 },
      uLesionSeverity: { value: 0 },
      uLesionEcc: { value: 0 },
    },
    vertexShader,
    fragmentShader,
    side: DoubleSide,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: ZeroFactor,
    blendDst: SrcColorFactor,
  })
}

export type AttenuatorLook = 'normal' | 'highlight' | 'dim'

/** Highlight cyan (#00f0ff) as a multiplicative tint: thick vessel regions tend towards this colour. */
const HIGHLIGHT_TINT: [number, number, number] = [0.0, 0.94, 1.0]
/** Non-highlighted branches, while another one is highlighted: lighter and slightly less dense. */
const DIM_TINT = 0.5
const DIM_DENSITY = 0.6
/** Raised so thin distal segments still read as saturated cyan instead of fading to the background. */
const HIGHLIGHT_DENSITY = 2.2

/** Switch a material between its normal contrast look, the highlight tint, and the dimmed look. */
export function setAttenuatorLook(material: ShaderMaterial, look: AttenuatorLook) {
  const tint = material.uniforms.uTint.value as Vector3
  const density = material.uniforms.uDensity
  if (look === 'highlight') {
    tint.set(...HIGHLIGHT_TINT)
    density.value = HIGHLIGHT_DENSITY
  } else if (look === 'dim') {
    tint.set(DIM_TINT, DIM_TINT, DIM_TINT)
    density.value = DIM_DENSITY
  } else {
    tint.copy(NEUTRAL_TINT)
    density.value = 1
  }
}

/** A lesion resolved to the case patient frame (LPS mm, isocenter at the origin), ready for the shader. */
export interface LesionShaderParams {
  /** Lesion centre on the branch centerline. */
  pos: Vector3
  /** Unit vessel direction at the centre. */
  axis: Vector3
  /** Unit direction of the plaque side for an eccentric lesion, perpendicular to axis. */
  dir: Vector3
  lengthMm: number
  severity: number
  eccentric: boolean
}

/** Switch the synthetic stenosis of a tube material on (params) or off (null). */
export function setLesionUniforms(material: ShaderMaterial, params: LesionShaderParams | null) {
  const u = material.uniforms
  if (!params) {
    u.uHasLesion.value = 0
    return
  }
  u.uHasLesion.value = 1
  ;(u.uLesionPos.value as Vector3).copy(params.pos)
  ;(u.uLesionAxis.value as Vector3).copy(params.axis)
  ;(u.uLesionDir.value as Vector3).copy(params.dir)
  u.uLesionLength.value = params.lengthMm
  u.uLesionSeverity.value = params.severity
  u.uLesionEcc.value = params.eccentric ? 1 : 0
}
