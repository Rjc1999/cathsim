import type { ReactNode } from 'react'
import { EyeOff, Layers, Tag } from 'lucide-react'
import type { VesselId } from '../lib/heartIndex'
import { useTree } from '../lib/tree'
import { labelsShown, useGantryStore } from '../store/useGantryStore'
import { ProTipCard } from './ProTipCard'

export const btn =
  'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold transition-colors ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 disabled:cursor-not-allowed disabled:opacity-40'
export const btnGhost = `${btn} border border-zinc-700 text-zinc-300 hover:border-zinc-500`

export function VesselToggle() {
  const vessel = useGantryStore((s) => s.vessel)
  const setVessel = useGantryStore((s) => s.setVessel)
  const options: { id: VesselId; label: string }[] = [
    { id: 'LCA', label: 'Inject LCA' },
    { id: 'RCA', label: 'Inject RCA' },
  ]
  return (
    <div role="group" aria-label="Vessel" className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={vessel === o.id}
          onClick={() => setVessel(o.id)}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
            vessel === o.id ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Labelled on/off switch button: "Landmarks: On". */
function ToggleButton({
  label,
  on,
  onClick,
  icon,
  disabled,
  value,
  title,
}: {
  label: string
  on: boolean
  onClick: () => void
  icon: ReactNode
  disabled?: boolean
  /** Overrides the On / Off text (the lesion game shows Hidden / Revealed). */
  value?: string
  title?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      title={title}
      onClick={onClick}
      className={`${btn} border px-3 ${
        on ? 'border-sky-500 bg-sky-500/15 text-sky-200' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500'
      }`}
    >
      {icon}
      <span>
        {label}: <span className="font-bold">{value ?? (on ? 'On' : 'Off')}</span>
      </span>
    </button>
  )
}

export function ViewToggles() {
  const landmarks = useGantryStore((s) => s.landmarks)
  const labels = useGantryStore(labelsShown)
  const labelsMode = useGantryStore((s) => s.labelsMode)
  const { toggleLandmarks, toggleLabels } = useGantryStore.getState()
  return (
    <div className="grid grid-cols-2 gap-2">
      <ToggleButton label="Landmarks" on={landmarks} onClick={toggleLandmarks} icon={<Layers size={16} aria-hidden />} />
      <ToggleButton
        label="Labels"
        on={labels}
        onClick={toggleLabels}
        icon={labelsMode === 'hidden' ? <EyeOff size={16} aria-hidden /> : <Tag size={16} aria-hidden />}
        // In the lesion game the names are the answer: hidden while working a case, revealed in the debrief, never user-toggled.
        disabled={labelsMode !== 'user'}
        value={labelsMode === 'hidden' ? 'Hidden' : labelsMode === 'revealed' ? 'Revealed' : undefined}
        title={labelsMode === 'hidden' ? 'Branch names are hidden while you work a case' : undefined}
      />
    </div>
  )
}

/** Branch chips: an alternative to tapping a vessel or label (handy on a phone), shared with the twin. */
export function BranchChips() {
  const vessel = useGantryStore((s) => s.vessel)
  const highlightId = useGantryStore((s) => s.highlightId)
  const toggleHighlight = useGantryStore((s) => s.toggleHighlight)
  const branches = useTree(vessel)
  return (
    <div>
      <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-widest text-zinc-500">Highlight branch</h2>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Highlight branch">
        {branches.map((b) => {
          const active = b.id === highlightId
          return (
            <button
              key={b.id}
              type="button"
              aria-pressed={active}
              title={b.label}
              onClick={() => toggleHighlight(b.id)}
              className={`rounded-full border px-3 py-1 font-mono text-xs font-semibold transition-colors ${
                active
                  ? 'border-cyan-300 bg-cyan-300 text-zinc-950'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200'
              }`}
            >
              {b.id}
            </button>
          )
        })}
      </div>
    </div>
  )
}


/**
 * Explore HUD: injection, the live pro-tip, the landmark / label toggles and the highlight chips. No targets, no pedal, no
 * grading (that is the Target Views trainer, see TargetHUD).
 */
export function HUD() {
  return (
    <div className="flex w-full flex-col gap-4">
      <VesselToggle />
      <ProTipCard />
      <ViewToggles />
      <BranchChips />
    </div>
  )
}
