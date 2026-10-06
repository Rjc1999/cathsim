import { Suspense, useEffect, useRef } from 'react'
import { useFrame, useThree, type RootState } from '@react-three/fiber'
import { RecoverableCanvas } from './RecoverableCanvas'
import { DirectionalLight, PerspectiveCamera, Vector2 } from 'three'
import { useGantryDrag } from '../hooks/useGantryDrag'
import { detectorDirection, detectorUp } from '../lib/gantry'
import { makeTwinProjector, TWIN_DISTANCE_MM, TWIN_FOV_DEG } from '../lib/projection'
import { verdictTone } from '../lib/verdictTone'
import { useGameStore } from '../store/useGameStore'
import { useGantryStore } from '../store/useGantryStore'
import { LockRing } from './GameOverlay'
import { GantryReadout } from './GantryReadout'
import { ToyHeart } from './ToyHeart'

// Twin camera distance (mm) and vertical FOV (deg) frame the curated heart (~160 x 190 mm, off-centre) with margin;
// they live in lib/projection.ts so overlays can project into this camera in closed form.
const BACKGROUND = '#1a2230'

/**
 * Keeps the twin's camera locked to the C-arm. The camera sits on the DETECTOR side of the isocenter looking at it,
 * with the detector's up vector, so the heart is seen exactly as the fluoro monitor frames it (patient-left on
 * screen-right, no mirroring needed: the detector-side view is the operator's face-to-face view). With
 * `twinBehind` the camera moves to the tube side, showing the posterior surface and the wrap-around of the RCA / LCx.
 */
function TwinRig() {
  const invalidate = useThree((s) => s.invalidate)
  const light = useRef<DirectionalLight>(null)

  useEffect(() => useGantryStore.subscribe(() => invalidate()), [invalidate])

  useFrame(({ camera }) => {
    const s = useGantryStore.getState()
    const [dx, dy, dz] = detectorDirection(s.alpha, s.beta)
    const [ux, uy, uz] = detectorUp(s.alpha, s.beta)
    const side = s.twinBehind ? -1 : 1
    const cam = camera as PerspectiveCamera
    cam.up.set(ux, uy, uz)
    cam.position.set(dx * TWIN_DISTANCE_MM * side, dy * TWIN_DISTANCE_MM * side, dz * TWIN_DISTANCE_MM * side)
    cam.lookAt(0, 0, 0)
    // Key light rides with the camera (slightly above it) so the shading stays consistent as the heart "rotates".
    light.current?.position.copy(cam.position).addScaledVector(cam.up, 160)
  })

  return (
    <>
      <fog attach="fog" args={[BACKGROUND, TWIN_DISTANCE_MM, TWIN_DISTANCE_MM + 340]} />
      <hemisphereLight args={['#dfe8f5', '#3a3038', 1.1]} />
      <directionalLight ref={light} intensity={2.4} />
    </>
  )
}

/**
 * Lesion game reveal on the twin: the same target-lock ring as the fluoro view, placed by projecting the lesion centre into this
 * camera in closed form (lib/projection.ts), so it follows the heart as the C-arm moves and when the view flips to "behind".
 */
function TwinReveal({ compact }: { compact: boolean }) {
  const alpha = useGantryStore((s) => s.alpha)
  const beta = useGantryStore((s) => s.beta)
  const behind = useGantryStore((s) => s.twinBehind)
  const current = useGameStore((s) => s.current)
  const result = useGameStore((s) => s.result)
  const roundNo = useGameStore((s) => s.roundNo)
  if (!current || !result) return null
  const [x, y] = makeTwinProjector(alpha, beta, behind)(current.ctx.centre)
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <LockRing key={roundNo} x={x} y={y} tone={verdictTone(result.verdict)} label={current.truthLabel} small={compact} />
    </div>
  )
}

/**
 * Side-by-side companion: a lit 3D teaching heart that orbits in lockstep with the C-arm. Dragging it drives the
 * gantry exactly like dragging the fluoro image. Tapping a coronary branch highlights it here and in the fluoro view.
 */
export function AnatomyTwin({ compact = false, paused = false }: { compact?: boolean; paused?: boolean }) {
  const phase = useGantryStore((s) => s.phase)
  const behind = useGantryStore((s) => s.twinBehind)
  const toggleBehind = useGantryStore((s) => s.toggleTwinBehind)
  const reveal = useGameStore((s) => s.phase === 'debrief')
  const stateRef = useRef<RootState | null>(null)

  // A minimised window is not drawn, so stop rendering it; redraw once it is back.
  useEffect(() => {
    if (!paused) stateRef.current?.invalidate()
  }, [paused])

  const drag = useGantryDrag({
    onTap: (clientX, clientY, el) => {
      const state = stateRef.current?.get()
      if (!state) return
      const rect = el.getBoundingClientRect()
      const ndc = new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1))
      state.raycaster.setFromCamera(ndc, state.camera)
      // Nearest coronary tube under the tap, seeing through the translucent chambers.
      const hit = state.raycaster.intersectObjects(state.scene.children, true).find((h) => h.object.userData.branchId)
      if (hit) useGantryStore.getState().toggleHighlight(hit.object.userData.branchId as string)
    },
  })

  return (
    <div
      role="application"
      aria-label="3D anatomical heart, rotating with the C-arm. Drag to move the C-arm; tap a vessel to highlight it."
      tabIndex={0}
      className={`relative aspect-square w-full touch-none select-none overflow-hidden rounded-2xl outline-none ring-1 ring-zinc-800 focus-visible:ring-2 focus-visible:ring-sky-500 ${
        phase === 'live' ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'
      }`}
      style={{ background: `radial-gradient(circle at 50% 42%, #2b3547 0%, ${BACKGROUND} 70%, #11161f 100%)` }}
      {...drag}
    >
      <RecoverableCanvas
        flat
        dpr={[1, 2]}
        frameloop={paused ? 'never' : 'demand'}
        camera={{ fov: TWIN_FOV_DEG, near: 60, far: 1000 }}
        gl={{ alpha: true, antialias: true }}
        onCreated={(state) => {
          stateRef.current = state
        }}
      >
        <TwinRig />
        <Suspense fallback={null}>
          <ToyHeart />
        </Suspense>
      </RecoverableCanvas>

      {reveal && <TwinReveal compact={compact} />}

      {!compact && (
        <>
          <GantryReadout className="absolute left-2.5 top-2.5" />
          <div className="pointer-events-none absolute bottom-2.5 left-3 font-mono text-[10px] tracking-wider text-zinc-400">
            3D ANATOMY · {behind ? 'FROM BEHIND (TUBE SIDE)' : 'FROM DETECTOR'}
          </div>
          <button
            type="button"
            aria-pressed={behind}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={toggleBehind}
            className="absolute right-2.5 top-2.5 rounded-md bg-black/60 px-2.5 py-1.5 font-mono text-[10px] font-semibold tracking-wider text-zinc-200 ring-1 ring-white/10 transition-colors hover:bg-black/80 aria-pressed:bg-sky-500/25 aria-pressed:text-sky-200"
          >
            LOOK FROM BEHIND
          </button>
        </>
      )}
    </div>
  )
}
