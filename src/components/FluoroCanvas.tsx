import { Suspense, type MutableRefObject } from 'react'
import { Canvas, type RootState } from '@react-three/fiber'
import type { VesselId } from '../lib/heartIndex'
import { verticalFovDeg } from '../lib/gantry'
import { LabelProjector, type LabelRegistry } from './BranchLabels'
import { CArmController } from './CArmController'
import { DETECTOR_BG } from './CollimatedFrame'
import { CoronaryTree } from './CoronaryTree'
import { Landmarks } from './Landmarks'
import { SoftTissueShadow } from './SoftTissueShadow'
import { VenousTree } from './VenousTree'

interface FluoroCanvasProps {
  vessel: VesselId
  /** Fixed pose for static previews; omit to follow the live gantry store. */
  alpha?: number
  beta?: number
  /** 'demand' (the default) renders only on change, which saves battery; 'never' pauses a hidden window. */
  frameloop?: 'always' | 'demand' | 'never'
  /** Receives the r3f state (camera, invalidate, size...) for imperative hit-testing and redraws by the parent. */
  stateRef?: MutableRefObject<RootState | null>
  /** Live viewport only: DOM registry of the branch labels, positioned each frame. */
  labelRegistry?: MutableRefObject<LabelRegistry>
}

/**
 * One fluoro image: a perspective camera at the X-ray tube (fov = detector FOV at SID) looking at the isocenter.
 * `flat` disables tone mapping; alpha:false gives an opaque canvas so the multiply blends composite onto #d2d7dc.
 * Near/far bracket SOD ± ~350 mm, which contains the coronary tree and the spine/diaphragm landmarks.
 */
export function FluoroCanvas({ vessel, alpha, beta, frameloop = 'demand', stateRef, labelRegistry }: FluoroCanvasProps) {
  return (
    <Canvas
      flat
      dpr={[1, 2]}
      frameloop={frameloop}
      gl={{ alpha: false, antialias: true }}
      camera={{ fov: verticalFovDeg(), near: 350, far: 1200 }}
      onCreated={(state) => {
        state.gl.setClearColor(DETECTOR_BG, 1)
        if (stateRef) stateRef.current = state
      }}
    >
      <CArmController alpha={alpha} beta={beta} />
      <Landmarks />
      {/* The model streams in; the canvas stays a plain detector until it arrives. */}
      <Suspense fallback={null}>
        <SoftTissueShadow />
        <CoronaryTree vessel={vessel} />
      </Suspense>
      {/* Explore-only venous layer; its own Suspense boundary inside, so it never blanks the arteries while it streams in. */}
      <VenousTree />
      {labelRegistry && <LabelProjector vessel={vessel} registry={labelRegistry} />}
    </Canvas>
  )
}
