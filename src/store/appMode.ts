import { targetsFor } from '../data/targets'
import { useGameStore } from './useGameStore'
import { useGantryStore, type AppMode } from './useGantryStore'

/**
 * The only way to change the app mode. Every real switch starts from a clean, neutral image (LCA injected, AP 0/0, 1.0x centred, live, user-owned
 * labels and highlighting, no assessment), so nothing from one mode (a frozen grade, the game's hidden names, its lesion) leaks into
 * the next. Entering the game then starts its first round, leaving it drops the lesion. Explore never has a lesion.
 */
export function setAppMode(next: AppMode) {
  const prev = useGantryStore.getState().mode
  if (prev === next) return
  if (prev === 'game') useGameStore.getState().exit()
  useGantryStore.setState({
    mode: next,
    vessel: 'LCA',
    targetId: targetsFor('LCA')[0].id,
    alpha: 0,
    beta: 0,
    zoom: 1,
    panOffset: [0, 0],
    phase: 'live',
    result: null,
    highlightId: null,
    labelsMode: 'user',
    highlightLocked: false,
  })
  if (next === 'game') useGameStore.getState().enter()
}
