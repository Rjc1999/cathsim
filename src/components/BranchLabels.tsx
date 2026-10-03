import { useMemo, type MutableRefObject } from 'react'
import { useFrame } from '@react-three/fiber'
import { Vector3 } from 'three'
import type { VesselId } from '../lib/heartIndex'
import { useTree } from '../lib/tree'
import { labelsShown, useGantryStore } from '../store/useGantryStore'

/** DOM handles of one label, filled in by the overlay and driven each frame by the projector. */
export interface LabelEls {
  root: HTMLDivElement
  line: SVGLineElement
  pill: HTMLButtonElement
}
export type LabelRegistry = Map<string, LabelEls>

/** Distance (px) from the vessel anchor to the pill centre. */
const LEADER_PX = 26
/** Keep pill centres this far (px) inside the canvas edge. */
const EDGE_PX = 16

/**
 * Overlay half (DOM, un-mirrored): one small pill + faint leader line per branch of the injected vessel.
 * Positions are written imperatively by <LabelProjector/> every rendered frame, so dragging never re-renders React.
 * Tapping a pill highlights that branch (tap again to clear), in the fluoro image and on the 3D twin.
 */
export function BranchLabels({ vessel, registry }: { vessel: VesselId; registry: MutableRefObject<LabelRegistry> }) {
  // Effective visibility: the user's toggle, except that the lesion game hides every pill while hunting and shows them in the debrief.
  const visible = useGantryStore(labelsShown)
  const highlightId = useGantryStore((s) => s.highlightId)
  const toggleHighlight = useGantryStore((s) => s.toggleHighlight)
  const branches = useTree(vessel)
  if (!visible) return null

  return (
    <div className="pointer-events-none absolute inset-0">
      {branches.map((b) => {
        const active = b.id === highlightId
        return (
          <div
            key={b.id}
            ref={(root) => {
              if (!root) {
                registry.current.delete(b.id)
                return
              }
              registry.current.set(b.id, {
                root,
                line: root.querySelector('line')!,
                pill: root.querySelector('button')!,
              })
            }}
            className="absolute left-0 top-0"
            style={{ visibility: 'hidden' }}
          >
            <svg className="absolute left-0 top-0 overflow-visible" width="1" height="1" aria-hidden>
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="0"
                stroke={active ? '#00b8c4' : '#3f3f46'}
                strokeWidth="1"
                strokeOpacity="0.75"
              />
            </svg>
            <button
              type="button"
              aria-pressed={active}
              aria-label={`Highlight ${b.label}`}
              // Stop the viewport's drag/tap gesture from starting underneath the pill.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => toggleHighlight(b.id)}
              className={`pointer-events-auto absolute left-0 top-0 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold leading-tight ring-1 transition-colors ${
                active
                  ? 'bg-cyan-300 text-zinc-950 ring-cyan-100'
                  : 'bg-zinc-900/85 text-zinc-100 ring-zinc-500 hover:bg-zinc-800'
              }`}
            >
              {b.id}
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * Canvas half: each rendered frame, project every branch's anchor with the live camera (`vector.project`), apply the
 * display mirror (the canvas is flipped horizontally by CollimatedFrame while the overlay is not), and push the
 * result into the label DOM. The pill sits perpendicular to the local projected vessel direction, on the side away
 * from the tree centroid, so labels fan out instead of stacking on the vessels.
 */
export function LabelProjector({ vessel, registry }: { vessel: VesselId; registry: MutableRefObject<LabelRegistry> }) {
  const branches = useTree(vessel)
  const tmp = useMemo(() => ({ a: new Vector3(), b: new Vector3(), c: new Vector3() }), [])

  useFrame(({ camera, size }) => {
    if (!labelsShown(useGantryStore.getState()) || registry.current.size === 0) return
    // CArmController has just re-posed the camera in this same frame, but matrixWorldInverse (which project() reads) is only
    // refreshed inside render(). Refresh it now, or a one-step pose jump (Reset to AP, double-tap, target switch) leaves the
    // pills projected through the previous pose until the next frame, which never comes on a demand-rendered canvas.
    camera.updateMatrixWorld()
    const { width, height } = size
    // Screen px with the horizontal mirror applied.
    const toScreen = (v: Vector3): [number, number] => [(1 - (v.x * 0.5 + 0.5)) * width, (1 - (v.y * 0.5 + 0.5)) * height]

    const anchors = branches.map((br) => {
      const [x, y] = toScreen(br.curve.getPointAt(br.labelT, tmp.a).project(camera))
      return { br, x, y }
    })
    const cx = anchors.reduce((s, p) => s + p.x, 0) / anchors.length
    const cy = anchors.reduce((s, p) => s + p.y, 0) / anchors.length

    for (const { br, x, y } of anchors) {
      const els = registry.current.get(br.id)
      if (!els) continue
      const [x1, y1] = toScreen(br.curve.getPointAt(Math.max(0, br.labelT - 0.05), tmp.b).project(camera))
      const [x2, y2] = toScreen(br.curve.getPointAt(Math.min(1, br.labelT + 0.05), tmp.c).project(camera))
      const tx = x2 - x1
      const ty = y2 - y1
      const len = Math.hypot(tx, ty)
      let nx = len > 1e-3 ? -ty / len : 0.7
      let ny = len > 1e-3 ? tx / len : -0.7
      if (nx * (x - cx) + ny * (y - cy) < 0) {
        nx = -nx
        ny = -ny
      }
      const px = Math.min(width - EDGE_PX, Math.max(EDGE_PX, x + nx * LEADER_PX))
      const py = Math.min(height - EDGE_PX, Math.max(EDGE_PX, y + ny * LEADER_PX))
      const ox = px - x
      const oy = py - y

      els.root.style.visibility = 'visible'
      els.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`
      els.line.setAttribute('x2', ox.toFixed(1))
      els.line.setAttribute('y2', oy.toFixed(1))
      els.pill.style.transform = `translate(${ox.toFixed(1)}px, ${oy.toFixed(1)}px) translate(-50%, -50%)`
    }
  })

  return null
}
