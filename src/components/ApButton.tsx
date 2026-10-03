import { Target } from 'lucide-react'
import { useGantryStore } from '../store/useGantryStore'

/** Header shortcut that returns the C-arm to AP (0° / 0°). Disabled while the image is held. */
export function ApButton() {
  const resetGantry = useGantryStore((s) => s.resetGantry)
  const live = useGantryStore((s) => s.phase === 'live')
  return (
    <button
      type="button"
      disabled={!live}
      onClick={resetGantry}
      title="Return the gantry to AP (0° / 0°)"
      className="inline-flex items-center gap-1 rounded-lg border border-zinc-700 px-2 py-1.5 text-xs font-semibold text-zinc-300 hover:border-zinc-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Target size={13} aria-hidden /> AP
    </button>
  )
}
