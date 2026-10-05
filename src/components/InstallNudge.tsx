import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useInstallPrompt } from '../hooks/useInstallPrompt'

const VISITS_KEY = 'cathsim_visits'
const SESSION_KEY = 'cathsim_visit_counted'
const NUDGE_KEY = 'cathsim_install_nudge'
/** A returning visitor is offered the install after this much active time; a first-time visitor after the longer one. */
const RETURNING_AFTER_S = 15
const FIRST_VISIT_AFTER_S = 180

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage blocked: the nudge then simply never fires (it needs the persisted flag to stay one-time).
  }
}

/** Counts this browser session once (a reload does not count) and returns the total number of visits. */
function countVisit(): number {
  let visits = Number(read(VISITS_KEY)) || 0
  try {
    if (sessionStorage.getItem(SESSION_KEY) !== '1') {
      sessionStorage.setItem(SESSION_KEY, '1')
      visits += 1
      write(VISITS_KEY, String(visits))
    }
  } catch {
    // Without sessionStorage the visit is not counted.
  }
  return visits
}

const visits = typeof window === 'undefined' ? 0 : countVisit()

/**
 * One-time install offer: a small dismissible card that appears once, on a second visit or after a few minutes of use, and
 * only when the browser says the app is installable. Whatever the user does (install, "Not now", close), it never returns;
 * the footer "Install App" button stays available. It sits in a corner so the fluoro image is never covered.
 */
export function InstallNudge() {
  const { state, install } = useInstallPrompt()
  const [open, setOpen] = useState(false)
  const eligible = state === 'prompt' && read(NUDGE_KEY) === null

  // Counts seconds the tab is actually visible, then opens the card once.
  useEffect(() => {
    if (!eligible || open) return
    const threshold = visits >= 2 ? RETURNING_AFTER_S : FIRST_VISIT_AFTER_S
    let active = 0
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      active += 1
      if (active >= threshold) {
        window.clearInterval(id)
        write(NUDGE_KEY, 'shown')
        setOpen(true)
      }
    }, 1000)
    return () => window.clearInterval(id)
  }, [eligible, open])

  if (!open || state !== 'prompt') return null
  const close = () => setOpen(false)

  return (
    <div
      role="dialog"
      aria-label="Install CathSim"
      className="fixed right-3 bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-3 z-50 mx-auto max-w-sm rounded-lg border border-zinc-700 bg-zinc-900/95 p-3 shadow-xl backdrop-blur sm:right-4 sm:left-auto sm:mx-0"
    >
      <button
        type="button"
        aria-label="Dismiss"
        className="absolute top-1 right-1 flex size-8 items-center justify-center rounded text-zinc-500 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-sky-500"
        onClick={close}
      >
        <X size={14} aria-hidden />
      </button>
      <p className="pr-7 text-sm font-medium text-zinc-100">Install CathSim?</p>
      <p className="mt-0.5 pr-7 text-xs text-zinc-400">Add it to your home screen for full-screen use and offline practice.</p>
      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          className="inline-flex min-h-9 items-center gap-1.5 rounded bg-sky-600 px-3 text-xs font-medium text-white hover:bg-sky-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
          onClick={() => {
            close()
            void install()
          }}
        >
          <Download size={13} aria-hidden />
          Install
        </button>
        <button type="button" className="min-h-9 rounded px-3 text-xs text-zinc-400 hover:text-zinc-200 focus-visible:outline-2 focus-visible:outline-sky-500" onClick={close}>
          Not now
        </button>
      </div>
    </div>
  )
}
