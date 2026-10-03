import { DETECTOR_FOV_MM, SID_MM, SOD_MM, detectorDirection, detectorUp, type Vec3 } from './gantry'

/**
 * Pure-math twin of the fluoro camera, so overlays (marker, lesion ring) and magnetic snapping need no three.js camera
 * and stay exact at any gantry pose, including mid-animation.
 *
 * The camera sits at source = -d·SOD, looks along +d with up = detectorUp, so its right axis is d × up and a point p has
 *   depth = p·d + SOD,   x_cam = p·(d × up),   y_cam = p·up          (d·(d × up) = up·(d × up) = 0)
 * and NDC = (x_cam, y_cam) / (depth · tan(fov/2)), with tan(fov/2) = (DETECTOR_FOV/2) / SID for the square detector.
 * The result is returned as a percentage of the aperture box with the display mirror applied (patient-left on screen
 * right), the same convention as the branch labels: x% = 100·(1 − (ndc_x/2 + 1/2)), y% = 100·(1 − (ndc_y/2 + 1/2)).
 *
 * Table pan and zoom (store `panOffset` = [x, y] mm, +x screen-right, +y screen-up; `zoom`): the camera and its target are both
 * translated by t = -x·side + y·up (⊥ d, so depth is unchanged; side = d × up is camera-right, which the mirror turns into
 * screen-left). That is the patient moving with the source fixed. Then x_cam = p·side + x, y_cam = p·up - y, and zoom multiplies
 * the NDC, exactly like three.js `camera.zoom`.
 */
const TAN_HALF_FOV = DETECTOR_FOV_MM / 2 / SID_MM

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** A projector fixed to one gantry pose (build once, call for many points). */
export function makeProjector(
  alphaDeg: number,
  betaDeg: number,
  zoom = 1,
  pan: readonly [number, number] = [0, 0],
): (p: Vec3) => [number, number] {
  const d = detectorDirection(alphaDeg, betaDeg)
  const up = detectorUp(alphaDeg, betaDeg)
  const side = cross(d, up)
  return (p) => {
    const depth = dot(p, d) + SOD_MM
    const k = zoom / (depth * TAN_HALF_FOV)
    return [100 * (1 - ((dot(p, side) + pan[0]) * k * 0.5 + 0.5)), 100 * (1 - ((dot(p, up) - pan[1]) * k * 0.5 + 0.5))]
  }
}

export const projectToAperture = (p: Vec3, alphaDeg: number, betaDeg: number, zoom = 1, pan: readonly [number, number] = [0, 0]) =>
  makeProjector(alphaDeg, betaDeg, zoom, pan)(p)

/** Isocenter-plane millimetres per aperture pixel at a given zoom, for an aperture `aperturePx` wide (pointer deltas -> pan). */
export const mmPerAperturePx = (aperturePx: number, zoom: number) => (2 * TAN_HALF_FOV * SOD_MM) / zoom / aperturePx

/**
 * The 3D twin's camera (components/AnatomyTwin.tsx), same idea. It sits on the DETECTOR side (s = +1) or, with "look from
 * behind", on the tube side (s = -1), at distance D along s·d, looking at the isocenter with up = detectorUp, and is NOT
 * mirrored. With eye = s·D·d the camera axes are z = s·d, x = up × z = -s·(d × up), so
 *   depth = D - s·(p·d),   x_cam = -s·p·(d × up),   y_cam = p·up,   NDC = (x_cam, y_cam) / (depth · tan(fov/2)).
 * Result: percentage of the (square) canvas, y down.
 */
export const TWIN_DISTANCE_MM = 400
export const TWIN_FOV_DEG = 36

export function makeTwinProjector(alphaDeg: number, betaDeg: number, behind = false): (p: Vec3) => [number, number] {
  const s = behind ? -1 : 1
  const d = detectorDirection(alphaDeg, betaDeg)
  const up = detectorUp(alphaDeg, betaDeg)
  const side = cross(d, up)
  const tanHalf = Math.tan((TWIN_FOV_DEG * Math.PI) / 360)
  return (p) => {
    const depth = TWIN_DISTANCE_MM - s * dot(p, d)
    const k = 1 / (depth * tanHalf)
    return [100 * (-s * dot(p, side) * k * 0.5 + 0.5), 100 * (1 - (dot(p, up) * k * 0.5 + 0.5))]
  }
}
