import { create } from 'zustand'
import type { SyntheticLesion } from '../types/lesion'

interface LesionState {
  /** The lesion the shader draws, or null. Only the lesion game sets one; Explore never has a lesion. */
  activeLesion: SyntheticLesion | null
  setLesion: (lesion: SyntheticLesion | null) => void
}

export const useLesionStore = create<LesionState>()((set) => ({
  activeLesion: null,
  setLesion: (activeLesion) => set({ activeLesion }),
}))
