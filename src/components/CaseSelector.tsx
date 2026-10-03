import { useId } from 'react'
import { Loader2 } from 'lucide-react'
import { useGantryStore } from '../store/useGantryStore'
import { ApButton } from './ApButton'
import { ControlSchemeToggle } from './ControlSchemeToggle'

/**
 * Compact case picker for the header ("Case 1: Standard Anatomy"; it lists every case in the manifest, currently one,
 * and is disabled while there is nothing to switch to). Switching keeps the current gantry angle
 * (so the same projection can be compared across patients); the AP button is the quick way back to 0 / 0.
 */
export function CaseSelector() {
  const id = useId()
  const cases = useGantryStore((s) => s.availableCases)
  const current = useGantryStore((s) => s.currentCaseId)
  const loading = useGantryStore((s) => s.caseLoading)
  const error = useGantryStore((s) => s.caseError)
  const loadCase = useGantryStore((s) => s.loadCase)
  const entry = cases.find((c) => c.id === (loading ?? current))

  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="sr-only">
        Patient case
      </label>
      <select
        id={id}
        value={loading ?? current}
        disabled={cases.length < 2}
        onChange={(e) => void loadCase(e.target.value)}
        className="min-w-0 max-w-[14rem] truncate rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500 sm:max-w-[22rem]"
        title={entry ? (entry.provisional ? `${entry.label}. Branch labels are provisional.` : entry.label) : undefined}
      >
        {cases.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      <span className="grid w-4 place-items-center text-zinc-500" role="status" aria-live="polite">
        {loading ? <Loader2 size={14} className="animate-spin" aria-label="Loading patient" /> : null}
      </span>
      <ApButton />
      <ControlSchemeToggle />
      {error && (
        <span role="alert" className="text-xs text-rose-400">
          {error}
        </span>
      )}
    </div>
  )
}
