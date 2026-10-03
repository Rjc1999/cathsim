import { useEffect } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import type { PerspectiveCamera } from 'three'
import { detectorDirection, detectorUp, sourcePosition } from '../lib/gantry'
import { useGantryStore } from '../store/useGantryStore'

const NO_PAN: readonly [number, number] = [0, 0]

interface CArmControllerProps {
  /** Fixed pose (deg). If omitted, the controller follows the live pose in the gantry store. */
  alpha?: number
  beta?: number
}

/**
 * Places the camera at the X-ray tube and aims it at the isocenter (origin):
 *   position = iso - d·SOD,  lookAt(iso),  up = detector-up (roll is 0° by construction).
 * Live view only: zoom = camera.zoom, and the table pan shifts position and target together in the detector plane.
 * The scene is authored directly in LPS mm, so no axis remapping is needed; the CSS horizontal mirror applied
 * by CollimatedFrame turns this "view from the tube" into the operator's face-to-face monitor view.
 *
 * Renders nothing; it only drives the camera imperatively each frame (no React re-render per pointer move).
 */
export function CArmController({ alpha, beta }: CArmControllerProps) {
  const live = alpha === undefined || beta === undefined
  const invalidate = useThree((s) => s.invalidate)

  // Demand-rendered canvases: redraw whenever the store or the fixed pose changes.
  useEffect(() => {
    if (!live) return
    return useGantryStore.subscribe(() => invalidate())
  }, [live, invalidate])

  useEffect(() => {
    invalidate()
  }, [alpha, beta, invalidate])

  useFrame(({ camera }) => {
    const cam = camera as PerspectiveCamera
    const s = useGantryStore.getState()
    const a = live ? s.alpha : alpha
    const b = live ? s.beta : beta
    const [px, py, pz] = sourcePosition(a, b)
    const [ux, uy, uz] = detectorUp(a, b)
    // Table pan + zoom apply to the live view only (fixed-pose previews stay centred at 1.0x). The camera and its target move
    // together by t = -x·side + y·up (side = d × up, mirrored to screen-left), which is the patient sliding past a fixed source.
    const zoom = live ? s.zoom : 1
    const [panX, panY] = live ? s.panOffset : NO_PAN
    const [dx, dy, dz] = detectorDirection(a, b)
    // d × up
    const sx = dy * uz - dz * uy
    const sy = dz * ux - dx * uz
    const sz = dx * uy - dy * ux
    const tx = -panX * sx + panY * ux
    const ty = -panX * sy + panY * uy
    const tz = -panX * sz + panY * uz
    cam.up.set(ux, uy, uz)
    cam.position.set(px + tx, py + ty, pz + tz)
    cam.lookAt(tx, ty, tz)
    if (cam.zoom !== zoom) {
      cam.zoom = zoom
      cam.updateProjectionMatrix()
    }
  })

  return null
}
