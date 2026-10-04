import { useGLTF } from '@react-three/drei'
import { caseVeinsGlbUrl, caseVeinsIndexUrl, type BranchIndex } from './heartIndex'

/**
 * Cardiac venous system (coronary sinus, CS ostium, great / middle cardiac vein, posterior vein of the LV, anterior interventricular vein),
 * Explore mode only. It lives in its own GLB + index (public/models/<case>.veins.*, from scripts/build-veins.mjs) so the base heart that
 * every session downloads is unchanged: nothing here is fetched until the user first switches the venous layer on.
 *
 * This file has no React-store imports on purpose (the gantry store calls it); the hooks that read the store are in lib/veins.ts.
 */
export interface VeinIndex {
  version: number
  branches: BranchIndex[]
}

const indexes = new Map<string, Promise<VeinIndex>>()
const loaded = new Map<string, VeinIndex>()

function loadVeinIndex(caseId: string): Promise<VeinIndex> {
  let p = indexes.get(caseId)
  if (!p) {
    p = fetch(caseVeinsIndexUrl(caseId))
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load ${caseVeinsIndexUrl(caseId)} (${r.status})`)
        return r.json() as Promise<VeinIndex>
      })
      .then((idx) => {
        loaded.set(caseId, idx)
        return idx
      })
    p.catch(() => indexes.delete(caseId)) // allow a retry after a network failure
    indexes.set(caseId, p)
  }
  return p
}

/** Fetch the index and the GLB for a case and start parsing the GLB, so the canvases find it in drei's cache when the layer appears. */
export async function preloadVeins(caseId: string): Promise<void> {
  const glb = caseVeinsGlbUrl(caseId)
  await Promise.all([loadVeinIndex(caseId), fetch(glb).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${glb} (${r.status})`))))])
  useGLTF.preload(glb, false)
}

/** The venous branch index of a case, or undefined until preloadVeins() has resolved for it. */
export const getVeinIndex = (caseId: string): VeinIndex | undefined => loaded.get(caseId)

/** Whether `id` names a venous branch of the case (false while the venous layer has never been loaded). */
export const isVeinId = (caseId: string, id: string | null): boolean => id !== null && !!loaded.get(caseId)?.branches.some((b) => b.id === id)
