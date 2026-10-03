import type { ReactNode } from 'react'
import { Compass, Stethoscope, Target } from 'lucide-react'
import { setAppMode } from '../store/appMode'
import { useGameStore } from '../store/useGameStore'
import { useGantryStore, type AppMode } from '../store/useGantryStore'

const MODES: { id: AppMode; icon: ReactNode; short: string; long: string; selected: string }[] = [
  { id: 'explore', icon: <Compass size={15} aria-hidden />, short: 'Explore', long: 'Explore', selected: 'bg-sky-400 text-zinc-950' },
  { id: 'target', icon: <Target size={15} aria-hidden />, short: 'Targets', long: 'Target Views', selected: 'bg-amber-400 text-zinc-950' },
  { id: 'game', icon: <Stethoscope size={15} aria-hidden />, short: 'Lesion?', long: "Where's This Lesion?", selected: 'bg-rose-500 text-white' },
]

/**
 * `[ Explore ]  [ Target Views ]  [ Where's This Lesion? ]` – the three top-level modes, each with its own colour (sky = free
 * exploration, amber = view matching, rose = the game) so it is always obvious which one you are in.
 */
export function ModeToggle({ className = '' }: { className?: string }) {
  const mode = useGantryStore((s) => s.mode)
  return (
    <div role="group" aria-label="Mode" className={`grid grid-cols-3 gap-1 rounded-xl bg-zinc-900 p-1 ${className}`}>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-pressed={mode === m.id}
          aria-label={m.long}
          onClick={(e) => {
            e.currentTarget.blur()
            setAppMode(m.id)
          }}
          className={`flex items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 sm:px-3 ${
            mode === m.id ? m.selected : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {m.icon} <span className="sm:hidden">{m.short}</span>
          <span className="hidden sm:inline">{m.long}</span>
        </button>
      ))}
    </div>
  )
}

const BANNER = {
  explore: {
    box: 'border-sky-500/30 bg-sky-500/5 text-sky-100',
    lead: 'text-sky-300',
    name: 'Explore.',
    text: 'Free exploration of coronary anatomy with live angiographic pearls. No targets, no scoring.',
  },
  target: {
    box: 'border-amber-500/30 bg-amber-500/5 text-amber-100',
    lead: 'text-amber-300',
    name: 'Target Views.',
    text: 'Match the commanded projection. Adjust the C-arm to align with the target view, then pedal to grade.',
  },
} as const

/** One line under the header stating what the current mode is, in the mode's colour. */
export function ModeBanner() {
  const mode = useGantryStore((s) => s.mode)
  const hunting = useGameStore((s) => s.phase === 'hunt')
  const freezes = useGameStore((s) => s.freezes)
  const base = 'mb-3 rounded-xl border px-3 py-2 text-xs leading-relaxed'
  if (mode !== 'game') {
    const b = BANNER[mode]
    return (
      <p role="status" className={`${base} ${b.box}`}>
        <b className={`font-semibold ${b.lead}`}>{b.name}</b> {b.text}
      </p>
    )
  }
  return (
    <p role="status" className={`${base} border-rose-500/30 bg-rose-500/5 text-rose-100`}>
      <b className="font-semibold text-rose-300">Find the lesion.</b>{' '}
      {hunting ? (
        <>
          {freezes === 0 ? 'A significant narrowing is hiding in one of the coronaries. ' : ''}
          Branch names are hidden. Inject, steer the C-arm until you can see it, then work out <em>which vessel and which segment</em> from its
          course and the spine and diaphragm. Freeze to make the call.
        </>
      ) : (
        'One hidden narrowing per case. Deducing vessel and segment without on-screen labels.'
      )}
    </p>
  )
}
