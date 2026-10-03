import { useEffect, useMemo } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import {
  AddEquation,
  Color,
  CustomBlending,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Mesh,
  OneFactor,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  SrcColorFactor,
  WebGLRenderTarget,
  ZeroFactor,
} from 'three'
import { SOD_MM } from '../lib/gantry'
import { useHeartParts } from '../lib/heartModel'

/**
 * Relative attenuation coefficient of cardiac soft tissue / blood (1/mm), vs 0.6 for iodinated contrast.
 * The brief suggested 0.015–0.025, but the heart is ~100–140 mm thick along an AP ray, so even 0.015 gives an optical
 * density of ~1.5–2 (T ≈ 0.15), as dark as the left main. 0.003 gives OD ≈ 0.3–0.4 through the middle of the heart
 * (T ≈ 0.7): a clearly visible but soft cardiac shadow that never competes with the contrast-filled vessels. (0.004 was
 * tried first and read too heavy once the spine shadow stacked behind it.)
 */
export const SOFT_TISSUE_MU = 0.003

/** Scale of the thickness buffer relative to the canvas drawing buffer; the shadow is smooth, so half resolution is enough. */
const RT_SCALE = 0.75

const thicknessVertex = /* glsl */ `
  varying vec3 vPosV;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vPosV = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

/**
 * Signed path length: front faces add -d, back faces add +d, where d is the distance from the source along the ray,
 * measured from the isocenter (so values stay small for half-float precision). For closed, outward-wound meshes the
 * sum is exactly the length of the ray inside the volume; the offset cancels because front and back faces pair up.
 * `length(vPosV)` (not view-space z) is the true ray parameter under perspective.
 */
const thicknessFragment = /* glsl */ `
  uniform float uSod;
  varying vec3 vPosV;
  void main() {
    float d = length(vPosV) - uSod;
    gl_FragColor = vec4(gl_FrontFacing ? -d : d, 0.0, 0.0, 1.0);
  }
`

const compositeVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const compositeFragment = /* glsl */ `
  uniform sampler2D tThickness;
  uniform float uMu;
  varying vec2 vUv;
  void main() {
    float thickness = max(texture2D(tThickness, vUv).r, 0.0);
    gl_FragColor = vec4(vec3(exp(-uMu * thickness)), 1.0);
  }
`

/**
 * The cardiac silhouette as an authentic soft-tissue shadow.
 *
 * Vessels and landmarks have analytic path lengths; the heart is an arbitrary closed mesh, so its thickness is rendered:
 * pass 1 accumulates the signed ray depth of the FILLED cardiac volume (myocardium, atrial appendage, aortic root and
 * pulmonary trunk merged, with the chambers and vessel lumens filled; see scripts/lib/voxel.mjs) into a half-float
 * target with additive blending; pass 2 draws a full-screen quad that multiplies the
 * detector by exp(-mu · thickness), exactly like every other attenuator, so the order against vessels, spine and
 * diaphragm does not matter and a thick vessel (T ≈ 0.05) always cuts through the soft shadow.
 *
 * Must come AFTER <CArmController/> in the scene: pass 1 reads the camera pose that controller sets this frame.
 */
export function SoftTissueShadow() {
  const { shadow } = useHeartParts()
  const gl = useThree((s) => s.gl)
  const invalidate = useThree((s) => s.invalidate)

  const rt = useMemo(
    () =>
      new WebGLRenderTarget(2, 2, {
        type: HalfFloatType,
        format: RGBAFormat,
        depthBuffer: false,
        minFilter: LinearFilter,
        magFilter: LinearFilter,
      }),
    [],
  )

  const thicknessScene = useMemo(() => {
    const material = new ShaderMaterial({
      uniforms: { uSod: { value: SOD_MM } },
      vertexShader: thicknessVertex,
      fragmentShader: thicknessFragment,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
    })
    const scene = new Scene()
    const mesh = new Mesh(shadow, material)
    mesh.frustumCulled = false
    scene.add(mesh)
    return { scene, material }
  }, [shadow])

  const composite = useMemo(
    () => ({
      geometry: new PlaneGeometry(2, 2),
      material: new ShaderMaterial({
        uniforms: { tThickness: { value: rt.texture }, uMu: { value: SOFT_TISSUE_MU } },
        vertexShader: compositeVertex,
        fragmentShader: compositeFragment,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        blending: CustomBlending,
        blendEquation: AddEquation,
        blendSrc: ZeroFactor,
        blendDst: SrcColorFactor,
      }),
    }),
    [rt],
  )

  useEffect(() => {
    invalidate()
    return () => {
      thicknessScene.material.dispose()
      composite.geometry.dispose()
      composite.material.dispose()
      rt.dispose()
    }
  }, [thicknessScene, composite, rt, invalidate])

  const prevClear = useMemo(() => new Color(), [])
  useFrame(({ camera, size }) => {
    const dpr = gl.getPixelRatio()
    const w = Math.max(2, Math.round(size.width * dpr * RT_SCALE))
    const h = Math.max(2, Math.round(size.height * dpr * RT_SCALE))
    if (rt.width !== w || rt.height !== h) rt.setSize(w, h)

    const prevTarget = gl.getRenderTarget()
    const prevAlpha = gl.getClearAlpha()
    gl.getClearColor(prevClear)
    gl.setRenderTarget(rt)
    gl.setClearColor(0x000000, 0)
    gl.clear(true, false, false)
    gl.render(thicknessScene.scene, camera)
    gl.setRenderTarget(prevTarget)
    gl.setClearColor(prevClear, prevAlpha)
  })

  return <mesh geometry={composite.geometry} material={composite.material} frustumCulled={false} renderOrder={-1} />
}
