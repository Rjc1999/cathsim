import { forwardRef } from 'react'
import { Activity, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Heart } from 'lucide-react'
import type { PipDock, PipSide } from '../hooks/usePipDrag'

/** Chevron pointing from the edge back into the image (the direction the window will slide in from). */
const CHEVRON = { left: ChevronRight, right: ChevronLeft, top: ChevronDown, bottom: ChevronUp } as const

/**
 * The minimised picture-in-picture window: a small tab on the image edge it was pushed off. Tapping it brings the window back.
 * `kind` picks the icon (the 3D heart or the fluoro image), so you can tell which view is tucked away.
 */
export const PipTab = forwardRef<HTMLButtonElement, { dock: PipDock; kind: 'twin' | 'fluoro'; onRestore: (viaKeyboard: boolean) => void }>(
  function PipTab({ dock, kind, onRestore }, ref) {
    const { side, pos } = dock
    const vertical = side === 'left' || side === 'right'
    const Chevron = CHEVRON[side]
    const Icon = kind === 'twin' ? Heart : Activity
    const place: Record<PipSide, string> = {
      left: 'left-0 h-16 w-8 flex-col rounded-r-xl border-l-0',
      right: 'right-0 h-16 w-8 flex-col rounded-l-xl border-r-0',
      top: 'top-0 h-8 w-16 flex-row rounded-b-xl border-t-0',
      bottom: 'bottom-0 h-8 w-16 flex-row rounded-t-xl border-b-0',
    }
    return (
      <button
        ref={ref}
        type="button"
        onClick={(e) => onRestore(e.detail === 0)}
        aria-label={kind === 'twin' ? 'Show the 3D heart window again' : 'Show the fluoro window again'}
        title="Show window"
        className={`anim-pip-tab absolute z-30 flex items-center justify-center gap-0.5 border border-white/20 bg-zinc-950/85 text-zinc-200 shadow-lg backdrop-blur hover:bg-zinc-800 focus-visible:outline-2 focus-visible:outline-sky-400 ${place[side]}`}
        style={vertical ? { top: `${pos * 100}%`, translate: '0 -50%' } : { left: `${pos * 100}%`, translate: '-50% 0' }}
      >
        <Icon size={14} aria-hidden />
        <Chevron size={12} aria-hidden className="text-sky-300" />
      </button>
    )
  },
)

/** While dragging: a glowing strip on the edge that a release would minimise the window to. */
export function PipDropEdge({ side }: { side: PipSide }) {
  const place: Record<PipSide, string> = {
    left: 'left-0 top-0 h-full w-2',
    right: 'right-0 top-0 h-full w-2',
    top: 'left-0 top-0 h-2 w-full',
    bottom: 'bottom-0 left-0 h-2 w-full',
  }
  return <span aria-hidden className={`pointer-events-none absolute z-40 rounded-full bg-sky-400/80 shadow-[0_0_14px_rgba(56,189,248,0.9)] ${place[side]}`} />
}
