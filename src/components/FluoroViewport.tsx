import { useEffect, useRef } from 'react'
import type { RootState } from '@react-three/fiber'
import { Vector3 } from 'three'
import { useGantryDrag } from '../hooks/useGantryDrag'
import { DETECTOR_FOV_MM, SID_MM, SOD_MM } from '../lib/gantry'
import { makeProjector } from '../lib/projection'
import { getTree } from '../lib/tree'
import { getVeinTree } from '../lib/veins'
import { labelsShown, useGantryStore, venousShown } from '../store/useGantryStore'
import { BranchLabels, type LabelRegistry } from './BranchLabels'
import { APERTURE_INSET_PCT, CollimatedFrame } from './CollimatedFrame'
import { FluoroCanvas } from './FluoroCanvas'
import { GameOverlay } from './GameOverlay'
import { GantryReadout } from './GantryReadout'

/** Calibration ticks every 2 cm at the isocenter plane, in % of the square frame width. */
const TICK_PCT = (100 * 20) / ((DETECTOR_FOV_MM * SOD_MM) / SID_MM)
/** A tap selects the nearest vessel centerline within this many screen pixels. */
const HIT_RADIUS_PX = 18

/**
 * Crosshair and calibration ticks, anchored to the isocenter: they follow the table pan and the ticks (2 cm apart at the isocenter
 * plane) spread with the zoom, so the scale stays true. The viewBox is the aperture in %, anything past the circle is clipped.
 */
function Overlay() {
  const zoom = useGantryStore((s) => s.zoom)
  const pan = useGantryStore((s) => s.panOffset)
  const [cx, cy] = makeProjector(0, 0, zoom, pan)([0, 0, 0]) // the isocenter's image position does not depend on the gantry angle
  const tick = TICK_PCT * zoom
  const ticks = Array.from({ length: Math.ceil(70 / tick) }, (_, i) => (i + 1) * tick)
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
      <g transform={`translate(${cx.toFixed(3)} ${cy.toFixed(3)})`} stroke="#3f3f46" strokeWidth="0.22" strokeLinecap="round" opacity="0.7">
        {/* Crosshair with a gap at the centre so the isocenter stays visible */}
        <path d="M-42 0h36 M6 0h36 M0 -42v36 M0 6v36" />
        {ticks.flatMap((t) => [
          <path key={`h${t}`} d={`M${t} -1v2 M${-t} -1v2`} />,
          <path key={`v${t}`} d={`M-1 ${t}h2 M-1 ${-t}h2`} />,
        ])}
      </g>
    </svg>
  )
}

/** Magnification badge, shown only while zoomed in. */
function ZoomBadge() {
  const zoom = useGantryStore((s) => s.zoom)
  if (zoom <= 1.005) return null
  return (
    <div className="pointer-events-none absolute bottom-2.5 left-3 font-mono text-[11px] font-semibold tracking-wider text-zinc-300">
      {zoom.toFixed(1)}×
    </div>
  )
}

/**
 * Live fluoro viewport. Pointer control comes from useGantryDrag: left-drag / one finger rotates the C-arm (the Gantry / Natural
 * scheme sets the direction, Shift = fine), wheel / pinch zooms 1.0x to 2.5x, middle- or right-drag / two-finger drag pans the table,
 * double-click / double-tap resets to AP 1.0x centred, arrows = 1°, +/- = zoom. A single tap on a vessel highlights that branch (tap again to clear):
 * the nearest projected skeleton point of any branch group (including unnamed twigs) within HIT_RADIUS_PX wins. Once the view is locked the drag is inert but
 * taps, labels and highlights keep working so the frozen image can be studied.
 * `compact` (picture-in-picture thumbnail) hides the text overlays.
 */
export function FluoroViewport({ compact = false, paused = false }: { compact?: boolean; paused?: boolean }) {
  const vessel = useGantryStore((s) => s.vessel)
  const phase = useGantryStore((s) => s.phase)
  const labels = useGantryStore(labelsShown)
  const highlightId = useGantryStore((s) => s.highlightId)
  const landmarks = useGantryStore((s) => s.landmarks)
  const venous = useGantryStore(venousShown)

  const stateRef = useRef<RootState | null>(null)
  const registry = useRef<LabelRegistry>(new Map())

  // Overlay DOM (labels) mounts after the store change; make sure a frame runs once it exists.
  useEffect(() => {
    stateRef.current?.invalidate()
  }, [labels, vessel, highlightId, landmarks, venous, paused])

  const drag = useGantryDrag({
    zoomPan: true,
    onTap: (clientX, clientY, el) => {
      // The lesion game switches tap-to-highlight off until the debrief: a highlighted vessel would help identify it.
      if (useGantryStore.getState().highlightLocked) return
      const state = stateRef.current?.get()
      if (!state) return
      // The canvas fills the collimator aperture, which is inset within the square frame.
      const rect = el.getBoundingClientRect()
      const inset = (rect.width * APERTURE_INSET_PCT) / 100
      const left = rect.left + inset
      const top = rect.top + inset
      const w = rect.width - 2 * inset
      const h = rect.height - 2 * inset
      const v = new Vector3()
      let best: { id: string; d: number } | null = null
      const gantry = useGantryStore.getState()
      const pickable = venousShown(gantry) ? getVeinTree(gantry.currentCaseId) : getTree(gantry.vessel)
      for (const branch of pickable) {
        for (const [x, y, z] of branch.hitSamples) {
          v.set(x, y, z).project(state.camera)
          // Horizontal mirror: the canvas is flipped on screen, pointer coordinates are not.
          const sx = left + (1 - (v.x * 0.5 + 0.5)) * w
          const sy = top + (1 - (v.y * 0.5 + 0.5)) * h
          const d = Math.hypot(sx - clientX, sy - clientY)
          if (d < HIT_RADIUS_PX && (!best || d < best.d)) best = { id: branch.id, d }
        }
      }
      if (best) useGantryStore.getState().toggleHighlight(best.id)
    },
  })

  return (
    <div
      role="application"
      aria-label="Fluoroscopy viewport. Drag or use arrow keys to move the C-arm; scroll or pinch, or plus and minus, to zoom; right-drag or two-finger drag to pan the table; double-click to reset; tap a vessel to highlight it (not in the lesion game until the debrief)."
      tabIndex={0}
      className={`relative w-full touch-none select-none rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
        phase === 'live' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
      {...drag}
    >
      <CollimatedFrame
        overlay={
          <>
            <Overlay />
            {!compact && <BranchLabels vessel={vessel} registry={registry} />}
            {!compact && <GameOverlay />}
          </>
        }
      >
        <FluoroCanvas
          vessel={vessel}
          frameloop={paused ? 'never' : 'demand'}
          stateRef={stateRef}
          labelRegistry={compact ? undefined : registry}
        />
      </CollimatedFrame>
      {!compact && <GantryReadout className="absolute left-2.5 top-2.5" />}
      {!compact && <ZoomBadge />}
    </div>
  )
}
