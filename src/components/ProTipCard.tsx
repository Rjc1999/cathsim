import { useState } from 'react'
import { ChevronDown, ChevronUp, Lightbulb } from 'lucide-react'
import { getAngioProTip, getVenousProTip } from '../lib/proTips'
import { useGantryStore, venousShown } from '../store/useGantryStore'

const KEY = 'cathsim.protip.collapsed'
const load = () => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}
const save = (v: boolean) => {
  try {
    localStorage.setItem(KEY, v ? '1' : '0')
  } catch {
    /* storage unavailable: the choice just does not persist */
  }
}

/**
 * Explore mode only: a live angiographic pearl for the current C-arm pose. The selector returns the tip string itself, so the card
 * re-renders only when the tip changes (not on every drag pixel). Collapsible to a one-line pill to keep phones uncluttered.
 */
export function ProTipCard() {
  const tip = useGantryStore((s) => (venousShown(s) ? getVenousProTip(s.alpha, s.beta) : getAngioProTip(s.alpha, s.beta, s.vessel)))
  const [collapsed, setCollapsed] = useState(load)
  const toggle = () => {
    setCollapsed((c) => {
      save(!c)
      return !c
    })
  }
  return (
    <section aria-label="Angiographic pro-tip" className="rounded-xl border border-amber-500/30 bg-amber-500/5 text-amber-100">
      <div className="flex items-center gap-2 px-3 py-2">
        <Lightbulb size={14} className="shrink-0 text-amber-400" aria-hidden />
        <h2 className="text-xs font-semibold uppercase tracking-widest text-amber-300">Pro-tip</h2>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Show pro-tip' : 'Hide pro-tip'}
          className="ml-auto rounded-md p-1 text-amber-300 hover:bg-amber-500/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
        >
          {collapsed ? <ChevronDown size={16} aria-hidden /> : <ChevronUp size={16} aria-hidden />}
        </button>
      </div>
      {!collapsed && (
        <p aria-live="polite" className="min-h-[3.5rem] px-3 pb-3 text-sm leading-relaxed">
          {tip ?? <span className="text-amber-200/60">Keep steering: tips appear for the named views and landmark rules.</span>}
        </p>
      )}
    </section>
  )
}
