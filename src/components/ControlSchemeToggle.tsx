import { useEffect, useId, useRef, useState } from 'react'
import { Hand, Info, Orbit } from 'lucide-react'
import { useGantryStore, type ControlScheme } from '../store/useGantryStore'

const OPTIONS: { id: ControlScheme; label: string; icon: typeof Hand; hint: string }[] = [
  { id: 'gantry', label: 'Gantry', icon: Orbit, hint: 'Drag right = LAO, drag up = cranial' },
  { id: 'natural', label: 'Natural', icon: Hand, hint: 'Drag right = RAO, drag up = caudal (3D orbit)' },
]

export const CONTROL_SCHEME_TIP =
  "Why do Gantry controls feel reversed? Real cath lab table-side controls drive the physical C-arm arc—not the patient's heart. Pushing right swings the detector toward the patient's left side (LAO). Switch to Natural Drag for standard 3D orbit controls."

/**
 * Gantry / Natural drag direction switch (persisted in the store) with a tap-friendly info popover (a hover-only title would be
 * unreachable on a phone). Sits beside the AP reset in the header.
 */
export function ControlSchemeToggle() {
  const scheme = useGantryStore((s) => s.controlScheme)
  const setScheme = useGantryStore((s) => s.setControlScheme)
  const [open, setOpen] = useState(false)
  const tipId = useId()
  const root = useRef<HTMLDivElement>(null)

  // The popover closes on Escape or on a press anywhere outside it.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={root} className="relative flex items-center gap-1">
      <div role="group" aria-label="Drag control scheme" className="inline-flex gap-0.5 rounded-lg bg-zinc-900 p-0.5">
        {OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            aria-pressed={scheme === o.id}
            title={o.hint}
            onClick={() => setScheme(o.id)}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 ${
              scheme === o.id ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <o.icon size={13} aria-hidden /> {o.label}
          </button>
        ))}
      </div>
      <button
        type="button"
        aria-label="Why do Gantry controls feel reversed?"
        aria-expanded={open}
        aria-controls={tipId}
        onClick={() => setOpen((v) => !v)}
        className="grid h-7 w-7 place-items-center rounded-full text-zinc-500 transition-colors hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 aria-expanded:text-sky-300"
      >
        <Info size={15} aria-hidden />
      </button>
      {open && (
        <div
          id={tipId}
          role="note"
          className="absolute right-0 top-full z-40 mt-2 w-72 max-w-[calc(100vw-1.5rem)] rounded-xl border border-zinc-700 bg-zinc-900 p-3 text-xs leading-relaxed text-zinc-300 shadow-xl"
        >
          {CONTROL_SCHEME_TIP}
        </div>
      )}
    </div>
  )
}
