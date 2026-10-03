import { useEffect, useMemo } from 'react'
import { useThree } from '@react-three/fiber'
import { createAttenuatorMaterial } from '../lib/fluoroMaterial'
import {
  buildDiaphragmGeometry,
  buildSpineGeometry,
  DIAPHRAGM_MU,
  DIAPHRAGM_THICKNESS_MM,
  SPINE_MU,
} from '../lib/landmarks'
import { getHeartIndex } from '../lib/heartIndex'
import { useGantryStore } from '../store/useGantryStore'

/**
 * Thoracic spine and diaphragm dome as orienting shadows. They go through the same multiplicative Beer–Lambert
 * pass as the vessels but with ~12x lower attenuation, so vessels always cut through them (see lib/landmarks.ts).
 */
export function Landmarks() {
  const visible = useGantryStore((s) => s.landmarks)
  const caseId = useGantryStore((s) => s.currentCaseId)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    invalidate() // fixed-pose canvases (target preview) do not subscribe to the store
  }, [visible, invalidate])
  // The landmarks belong to the patient: rebuilt when the case changes (getHeartIndex() reads the active case).
  /* eslint-disable react-hooks/exhaustive-deps */
  const spine = useMemo(() => ({ geometry: buildSpineGeometry(getHeartIndex().landmarks.spine), material: createAttenuatorMaterial({ kind: 'tube', mu: SPINE_MU }) }), [caseId])
  const dome = useMemo(
    () => ({
      geometry: buildDiaphragmGeometry(getHeartIndex().landmarks.diaphragm_apex),
      material: createAttenuatorMaterial({ kind: 'shell', mu: DIAPHRAGM_MU, thickness: DIAPHRAGM_THICKNESS_MM }),
    }),
    [caseId],
  )
  /* eslint-enable react-hooks/exhaustive-deps */
  useEffect(
    () => () => {
      for (const o of [spine, dome]) {
        o.geometry.dispose()
        o.material.dispose()
      }
    },
    [spine, dome],
  )

  return (
    <group visible={visible} dispose={null}>
      <mesh geometry={spine.geometry} material={spine.material} frustumCulled={false} />
      <mesh geometry={dome.geometry} material={dome.material} frustumCulled={false} />
    </group>
  )
}
